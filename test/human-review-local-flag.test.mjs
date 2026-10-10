/**
 * The human-review flag is local to the agent's output (docs/adr/0012,
 * amended): the posted review never names a human, and `humanReviewNote`
 * carries the line instead.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assessComplexity, humanReviewNote } from '../plugins/review-voice/src/diff/complexity.ts';
import { openDatabase } from '../plugins/review-voice/src/store/db.ts';
import { recordRun } from '../plugins/review-voice/src/store/runs.ts';
import { GitHubClient } from '../plugins/review-voice/src/github/client.ts';
import { computeVerdict } from '../plugins/review-voice/src/publish/post.ts';

const HEAD = 'a'.repeat(40);
const REPO = 'acme/web';
const PR = 7;

const file = (path) => ({
  path,
  status: 'modified',
  class: 'source',
  language: 'typescript',
  additions: 1,
  deletions: 0,
  reviewed: true,
});

const HIGH = assessComplexity('', [file('src/auth/login.ts')]);
const NORMAL = assessComplexity('', [file('src/plain.ts')]);
const NOTE = humanReviewNote(HIGH);

function withDb(body) {
  const dir = mkdtempSync(join(tmpdir(), 'rv-hr-local-'));
  const previous = process.env.REVIEW_VOICE_DATA_DIR;
  process.env.REVIEW_VOICE_DATA_DIR = dir;
  const db = openDatabase(join(dir, 'review-voice.db'));
  const restore = () => {
    db.close();
    if (previous === undefined) delete process.env.REVIEW_VOICE_DATA_DIR;
    else process.env.REVIEW_VOICE_DATA_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  };
  return Promise.resolve()
    .then(() => body(db))
    .finally(restore);
}

const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

function fakeGitHub() {
  return async (url) => {
    const parsed = new URL(String(url));
    if (/\/pulls\/\d+$/.test(parsed.pathname)) return json({ head: { sha: HEAD } });
    if (parsed.pathname.endsWith('/check-runs')) {
      const done = { id: 1, name: 'build', status: 'completed', conclusion: 'success', completed_at: '2026-10-01T10:00:00Z' };
      return json({ total_count: 1, check_runs: [done] });
    }
    if (parsed.pathname.endsWith('/status')) return json({ state: 'success', total_count: 0, statuses: [] });
    return new Response('not found', { status: 404 });
  };
}

function record(db, output, extra = {}) {
  return recordRun(db, { repository: REPO, baseRef: null, headRef: HEAD, pullNumber: PR, diff: 'diff', output, ...extra });
}

const verdict = (db, review) =>
  computeVerdict({
    db,
    client: new GitHubClient({ allowlist: [REPO], token: 't', fetchImpl: fakeGitHub(), sleep: async () => {} }),
    repository: REPO,
    pullNumber: PR,
    head: HEAD,
    review,
  });

const verified = (path, line, severity) => ({
  candidateId: `${path}:${line}`,
  path,
  line,
  severity: { severity },
  confidenceSource: 'verifier',
  eligible: true,
});

const CLEAN = 'No actionable findings.';
const MINOR = '[minor] `src/cart.ts:12` - The total skips the discount. A discounted cart is overcharged.';
const IMPORTANT = '[important] `src/pay.ts:8` - The retry charges twice. A timeout bills the card again.';

const CASES = [
  { name: 'a capped approval', review: CLEAN, scores: [], event: 'COMMENT' },
  { name: 'REQUEST_CHANGES', review: IMPORTANT, scores: [verified('src/pay.ts', 8, 'important')], event: 'REQUEST_CHANGES' },
  { name: 'COMMENT', review: MINOR, scores: [verified('src/cart.ts', 12, 'minor')], event: 'COMMENT' },
];

for (const { name, review, scores, event } of CASES) {
  test(`a high run: ${name} posts a body with no mention of a human, and the note is in the output`, async () => {
    await withDb(async (db) => {
      record(db, review, { complexity: HIGH, scores });
      const { output } = await verdict(db, review);
      assert.equal(output.event, event);
      assert.doesNotMatch(output.payload.body, /human/i);
      for (const comment of output.payload.comments) assert.doesNotMatch(comment.body, /human/i);
      assert.doesNotMatch(output.preview, /human/i);
      assert.equal(output.humanReviewNote, NOTE);
      assert.match(output.humanReviewNote, /human reviewer/);
    });
  });
}

test('a normal run has no note in the output', async () => {
  await withDb(async (db) => {
    record(db, CLEAN, { complexity: NORMAL });
    const { output } = await verdict(db, CLEAN);
    assert.equal(output.event, 'APPROVE');
    assert.equal(output.humanReviewNote, null);
  });
});

test('a run with no recorded assessment has no note in the output', async () => {
  await withDb(async (db) => {
    record(db, CLEAN);
    const { output } = await verdict(db, CLEAN);
    assert.equal(output.humanReviewNote, null);
  });
});
