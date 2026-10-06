/**
 * A run that is both an uncovered carry (docs/adr/0017) and high-complexity
 * (docs/adr/0012): both caps hold it at COMMENT, the carry's plain summary
 * wins, and the posted body names neither human review nor the carry. The
 * agent-only fields still come back for the user.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../plugins/review-voice/src/store/db.ts';
import { recordRun } from '../plugins/review-voice/src/store/runs.ts';
import { GitHubClient } from '../plugins/review-voice/src/github/client.ts';
import { computeVerdict } from '../plugins/review-voice/src/publish/post.ts';

function github(head, conclusion) {
  const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  const impl = async (url) => {
    const path = new URL(String(url)).pathname;
    if (/\/pulls\/\d+$/.test(path)) return json({ head: { sha: head } });
    if (path.endsWith('/check-runs')) {
      return json({ total_count: 1, check_runs: [{ id: 1, name: 'build', status: 'completed', conclusion, completed_at: '2026-10-01T10:00:00Z' }] });
    }
    if (path.endsWith('/status')) return json({ state: 'success', total_count: 0, statuses: [] });
    return new Response('not found', { status: 404 });
  };
  return new GitHubClient({ allowlist: ['acme/web'], token: 't', fetchImpl: impl, sleep: async () => {} });
}

const limits = { maxDecisionPoints: 40, maxHunkDecisionPoints: 15, sensitivePaths: [] };
const high = { level: 'high', decisionPoints: 80, sensitivePaths: [], densestHunk: null, limits, reasons: ['80 decision points added'] };
const normal = { level: 'normal', decisionPoints: 0, sensitivePaths: [], densestHunk: null, limits, reasons: [] };

async function verdict({ complexity, covered, conclusion = 'success' }) {
  const head = 'c'.repeat(40);
  const dir = mkdtempSync(join(tmpdir(), 'rv-carry-complexity-'));
  const db = openDatabase(join(dir, 'review-voice.db'));
  try {
    const carry = { since: 'a'.repeat(40), head, interdiffReviewed: covered, refused: [], covered };
    const { reviewRunId } = recordRun(db, {
      repository: 'acme/web', baseRef: null, headRef: head, pullNumber: 7, diff: 'd',
      output: 'No actionable findings.', scores: [], complexity, carry,
    });
    return await computeVerdict({
      db, client: github(head, conclusion), repository: 'acme/web', pullNumber: 7, head,
      review: 'No actionable findings.', runId: reviewRunId,
    });
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test('an uncovered carry on a high-complexity change posts a plain COMMENT', async () => {
  const { output } = await verdict({ complexity: high, covered: false });
  assert.equal(output.event, 'COMMENT');
  assert.equal(output.payload.body, 'Not approving yet.');
  assert.doesNotMatch(JSON.stringify(output.payload), /human|carr|complex/i);
  assert.match(output.humanReviewNote, /Needs a human reviewer/);
  assert.equal(output.wouldHaveEvent, 'APPROVE');
  assert.ok(output.reasons.some((r) => /carried to this head/.test(r)));
});

test('a covered carry on a high-complexity change gets the complexity summary', async () => {
  const { output } = await verdict({ complexity: high, covered: true });
  assert.equal(output.event, 'COMMENT');
  assert.equal(output.payload.body, 'No problems found.');
  assert.doesNotMatch(JSON.stringify(output.payload), /human|carr|complex/i);
  assert.match(output.humanReviewNote, /Needs a human reviewer/);
});

test('an uncovered carry on a normal change has no human-review note', async () => {
  const { output } = await verdict({ complexity: normal, covered: false });
  assert.equal(output.event, 'COMMENT');
  assert.equal(output.payload.body, 'Not approving yet.');
  assert.equal(output.humanReviewNote, null);
  assert.equal(output.wouldHaveEvent, null);
  assert.equal(output.staleRequestChanges, null);
});
