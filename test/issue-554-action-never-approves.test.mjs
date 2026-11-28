/**
 * #554: on QuintinBotes/memory#149 the Action's verdict was APPROVE with one
 * finding. GitHub refused the approval ("GitHub Actions is not permitted to
 * approve pull requests."), so the finding was never posted. The Action now
 * never approves: a run recorded from the Action posts its approval as a
 * COMMENT that carries the findings, as `verdict.never_approve` does. A run
 * from anywhere else still approves.
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

const REPO = 'QuintinBotes/memory';
const PR = 149;
const HEAD = 'c'.repeat(40);
const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

function fakeGitHub() {
  return async (url) => {
    const path = new URL(String(url)).pathname;
    if (/\/pulls\/\d+$/.test(path)) return json({ head: { sha: HEAD } });
    if (path.endsWith('/check-runs')) return json({ total_count: 1, check_runs: [{ id: 1, name: 'test', status: 'completed', conclusion: 'success', completed_at: '2026-11-27T23:40:00Z' }] });
    if (path.endsWith('/status')) return json({ state: 'success', total_count: 0, statuses: [] });
    return new Response('not found', { status: 404 });
  };
}

async function verdictFor(t, origin, review) {
  const dir = mkdtempSync(join(tmpdir(), 'rv-554-'));
  const previous = process.env.REVIEW_VOICE_DATA_DIR;
  process.env.REVIEW_VOICE_DATA_DIR = dir;
  const db = openDatabase(join(dir, 'review-voice.db'));
  t.after(() => {
    db.close();
    if (previous === undefined) delete process.env.REVIEW_VOICE_DATA_DIR;
    else process.env.REVIEW_VOICE_DATA_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  });
  recordRun(db, {
    repository: REPO,
    baseRef: null,
    headRef: HEAD,
    pullNumber: PR,
    diff: 'diff',
    output: review,
    // A finding is posted only when the verifier passed it, as the pipeline records it.
    scores: review === NIT ? [{ candidateId: 'src/store.ts:40', path: 'src/store.ts', line: 40, severity: { severity: 'nit' }, confidenceSource: 'verifier', eligible: true }] : [],
    provenance: { origin, pluginVersion: '1.30.0', claudeVersion: null, mode: 'standard' },
  });
  const client = new GitHubClient({ allowlist: [REPO], token: 't', fetchImpl: fakeGitHub(), sleep: async () => {} });
  return (await computeVerdict({ db, client, repository: REPO, pullNumber: PR, head: HEAD, review })).output;
}

const NIT = '[nit] `src/store.ts:40` - This name shadows the import.';

test('#554: an approval from the Action posts as a COMMENT that carries its finding', async (t) => {
  const output = await verdictFor(t, 'action', NIT);
  assert.equal(output.event, 'COMMENT');
  assert.equal(output.action, 'post');
  assert.equal(output.payload.event, 'COMMENT');
  assert.equal(output.payload.body, '1 nit.');
  assert.equal(output.payload.comments.length, 1);
  assert.match(output.payload.comments[0].body, /This name shadows the import/);
});

test('#554: a clean review from the Action posts as a COMMENT saying no problems were found', async (t) => {
  const output = await verdictFor(t, 'action', 'No actionable findings.');
  assert.deepEqual([output.event, output.payload.body, output.payload.comments.length], ['COMMENT', 'No problems found.', 0]);
});

test('#554: the same review run anywhere else still approves', async (t) => {
  const output = await verdictFor(t, 'driver', NIT);
  assert.deepEqual([output.event, output.payload.event, output.payload.body], ['APPROVE', 'APPROVE', 'Approved, with 1 nit.']);
});
