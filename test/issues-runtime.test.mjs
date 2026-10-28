import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GitHubClient } from '../plugins/review-voice/src/github/client.ts';
import { collectRepository } from '../plugins/review-voice/src/corpus/collect.ts';
import { inferOutcome } from '../plugins/review-voice/src/corpus/outcome.ts';
import { storeEvents } from '../plugins/review-voice/src/corpus/store.ts';
import { openDatabase } from '../plugins/review-voice/src/store/db.ts';
import { retrievePrecedents } from '../plugins/review-voice/src/retrieval/retrieve.ts';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bundle = join(root, 'plugins/review-voice/dist/review-voice.mjs');

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'rv-runtime-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// challenge reads check-candidates output

test('challenge --candidates checked.json (the kept shape) cites the candidate intent in the prompt', (t) => {
  const dir = tempDir(t);
  const claim = 'The cache key omits the tenant, so one tenant reads the entries of another.';
  const files = { scores: join(dir, 'scores.json'), checked: join(dir, 'checked.json'), intent: join(dir, 'intent.json') };
  writeFileSync(
    files.scores,
    JSON.stringify({ eligible: [{ candidateId: 'cand_001', path: 'src/a.ts', line: 3, claim, failureMode: 'Cross-tenant read.' }] }),
  );
  writeFileSync(
    files.checked,
    JSON.stringify({
      kept: [{ candidate_id: 'cand_001', path: 'src/a.ts', line: 3, category: 'security', claim, failure_mode: 'Cross-tenant read.', intent_ref: 'int_001' }],
      dropped: [],
    }),
  );
  writeFileSync(
    files.intent,
    JSON.stringify({ statements: [{ id: 'int_001', kind: 'goal', statement: 'Cache per tenant.', quote: 'Every cache entry is scoped to its tenant.' }] }),
  );
  const result = spawnSync(
    process.execPath,
    [bundle, 'challenge', '--scores', files.scores, '--candidates', files.checked, '--intent', files.intent, '--emit-prompts'],
    { encoding: 'utf8', env: { ...process.env, REVIEW_VOICE_DATA_DIR: dir } },
  );
  assert.equal(result.status, 0, result.stderr);
  const [{ prompt }] = JSON.parse(result.stdout).prompts;
  assert.ok(prompt.includes('Every cache entry is scoped to its tenant.'), 'the cited intent quote');
  assert.ok(prompt.includes('Category: security'), 'a field only the candidate carries');
});

// outcome inference for ingested comments

const OWNER = { login: 'your-github-login', type: 'User' };
const AUTHOR = { login: 'pr-author', type: 'User' };
const comment = (id, path, line, body, extra = {}) => ({
  id,
  body,
  user: OWNER,
  created_at: '2026-09-01T00:00:00Z',
  path,
  line,
  original_line: line ?? 4,
  diff_hunk: '@@ -1,4 +1,4 @@',
  author_association: 'OWNER',
  ...extra,
});
const reply = (id, to, body, user = AUTHOR) => ({
  id,
  body,
  user,
  created_at: '2026-09-02T00:00:00Z',
  path: 'src/x.ts',
  line: 4,
  in_reply_to_id: to,
  diff_hunk: '@@ -1,4 +1,4 @@',
  author_association: 'CONTRIBUTOR',
});

const COMMENTS = [
  // Lines changed by a later commit, and the author agreed.
  comment(101, 'src/a.ts', null, 'The retry path mints a second token because the response returns before the transaction commits.'),
  reply(102, 101, 'Good catch, fixed in the next commit.'),
  // Turned down in reply.
  comment(201, 'src/b.ts', 9, 'The retry token should be minted after the transaction commits, not before the response.'),
  reply(202, 201, 'Thanks, but this is intentional: the token is idempotent.'),
  // Nothing at all.
  comment(301, 'src/c.ts', 3, 'Minting the retry token before the transaction commits lets a duplicate request through.'),
  // Lines changed, nobody said anything.
  comment(401, 'src/d.ts', null, 'A retry here mints another token since nothing waits for the transaction to commit.'),
  // Only a bot answered.
  comment(501, 'src/e.ts', 7, 'This retry can mint a token twice when the transaction commit is slow to land.'),
  reply(502, 501, 'Fixed, thanks!', { login: 'ci-helper[bot]', type: 'Bot' }),
];

async function collectAndStore(t) {
  const dir = tempDir(t);
  const fetchImpl = async (url) => {
    const href = String(url);
    const body = (data) => new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });
    if (/\/pulls\?/.test(href)) return body([{ number: 1, html_url: 'https://example.com/1', updated_at: '2026-09-03T00:00:00Z' }]);
    if (/\/pulls\/1\/comments/.test(href)) return body(COMMENTS);
    return body([]);
  };
  const stats = { pullRequestsScanned: 0, pullRequestsUnchanged: 0, commentsSeen: 0, bySource: { inline: 0, reviewSummary: 0, conversation: 0 }, eligible: 0, duplicates: 0, excluded: {} };
  const { events } = await collectRepository(
    new GitHubClient({ allowlist: ['acme/api'], token: 't', fetchImpl, sleep: async () => {} }),
    { repository: 'acme/api', ownerLogin: OWNER.login, maxPullRequests: 10, maxCommentsPerPull: 100, includeForks: false, includeConversationComments: false },
    stats,
  );
  const db = openDatabase(join(dir, 'corpus.db'));
  t.after(() => db.close());
  storeEvents(db, events);
  const rows = db.prepare('SELECT comment_id, outcome_status, outcome_certainty FROM review_events').all();
  const outcomes = Object.fromEntries(rows.map((row) => [row.comment_id, `${row.outcome_status}/${row.outcome_certainty}`]));
  return { db, events, outcomes };
}

test('sync infers each owner comment outcome from replies and changed anchors it already fetched', async (t) => {
  const { outcomes } = await collectAndStore(t);
  assert.equal(outcomes['101'], 'accepted/strong', 'lines changed and the author agreed');
  assert.equal(outcomes['201'], 'dismissed/strong', 'a reply turned it down');
  assert.equal(outcomes['301'], 'unknown/weak', 'silence is unknown, never negative');
  assert.equal(outcomes['401'], 'accepted/weak', 'a change alone is weak');
  assert.equal(outcomes['501'], 'unknown/weak', 'a bot reply is no answer');
  assert.equal(outcomes['102'], undefined, 'replies by others are not owner events');
});

test('a resolved thread whose lines changed is accepted and strong; resolution alone is weak', () => {
  assert.deepEqual(inferOutcome({ reply: null, resolved: true, changed: true }), { status: 'accepted', certainty: 'strong' });
  assert.deepEqual(inferOutcome({ reply: null, resolved: true, changed: false }), { status: 'accepted', certainty: 'weak' });
  assert.deepEqual(inferOutcome({ reply: 'acknowledge', resolved: null, changed: false }), { status: 'accepted', certainty: 'weak' });
  assert.deepEqual(inferOutcome({ reply: 'reject', resolved: true, changed: true }), { status: 'dismissed', certainty: 'strong' });
  assert.deepEqual(inferOutcome({ reply: null, resolved: null, changed: false }), { status: 'unknown', certainty: 'weak' });
});

test('retrieval weighs strong outcomes and treats a weak one as unknown', async (t) => {
  const { db } = await collectAndStore(t);
  const precedents = retrievePrecedents(db, {
    text: 'retry token transaction commits',
    repository: 'acme/api',
    maxPositive: 10,
    maxNegative: 10,
    now: new Date('2026-09-10T00:00:00Z'),
  });
  const weight = Object.fromEntries(precedents.map((p) => [p.eventId, p.weight]));
  const outcome = Object.fromEntries(precedents.map((p) => [p.eventId, p.outcome]));
  assert.ok(weight.ghc_101 > weight.ghc_301, 'accepted outweighs unknown');
  assert.ok(weight.ghc_201 < 0, 'a strong dismissal is negative evidence');
  assert.equal(weight.ghc_401, weight.ghc_301, 'a weak outcome weighs as unknown');
  assert.equal(outcome.ghc_401, 'unknown');
  assert.equal(outcome.ghc_101, 'accepted');
});

test('a re-sync records a newly visible outcome but never erases one with unknown', async (t) => {
  const { db, events } = await collectAndStore(t);
  const silent = events.find((e) => e.commentId === '301');
  storeEvents(db, [{ ...silent, outcome: { status: 'accepted', certainty: 'strong' } }]);
  storeEvents(db, [{ ...silent, outcome: { status: 'unknown', certainty: 'weak' } }]);
  const row = db.prepare("SELECT outcome_status, outcome_certainty FROM review_events WHERE comment_id = '301'").get();
  assert.deepEqual({ ...row }, { outcome_status: 'accepted', outcome_certainty: 'strong' });
});

// a SIGKILL to the CLI does not leave agents running

async function gone(pid, ms) {
  for (const end = Date.now() + ms; Date.now() < end; ) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

test('SIGKILL to the CLI still ends the agent process and its child within a few seconds', { skip: process.platform === 'win32' }, async (t) => {
  const dir = tempDir(t);
  const stub = join(dir, 'claude-stub.mjs');
  writeFileSync(
    stub,
    `#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
writeFileSync(process.env.STUB_CHILD_PID, JSON.stringify({ stub: process.pid, child: child.pid }));
setTimeout(() => {}, 60000);
`,
  );
  chmodSync(stub, 0o755);
  const schema = join(dir, 'schema.json');
  writeFileSync(schema, JSON.stringify({ type: 'object' }));
  const pids = join(dir, 'pids.json');
  const env = { ...process.env, REVIEW_VOICE_CLAUDE_BIN: stub, STUB_CHILD_PID: pids, REVIEW_VOICE_DATA_DIR: join(dir, 'data') };
  delete env.REVIEW_VOICE_FAKE_AGENTS;
  delete env.REVIEW_VOICE_AGENT_RUNNER;
  const cli = spawn(process.execPath, [bundle, 'agent', '--name', 'diff-analyst', '--model', 'haiku', '--schema', schema, '--cwd', dir], {
    env,
    stdio: ['pipe', 'ignore', 'ignore'],
  });
  t.after(() => {
    for (const pid of existsSync(pids) ? Object.values(JSON.parse(readFileSync(pids, 'utf8'))) : []) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {}
    }
  });
  cli.stdin.end('p');
  for (let i = 0; i < 500 && !existsSync(pids); i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(existsSync(pids), 'the stub started');
  const { stub: stubPid, child } = JSON.parse(readFileSync(pids, 'utf8'));

  cli.kill('SIGKILL');

  assert.ok(await gone(stubPid, 6000), 'the claude process is gone');
  assert.ok(await gone(child, 2000), 'its child is gone');
});
