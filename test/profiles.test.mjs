/**
 * Team profiles and cold start (docs/adr/0030): several reviewers pool into one
 * corpus, an empty corpus says so and uses the baseline voice, and --quick is a
 * bounded first sync.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../plugins/review-voice/src/policy/load.ts';
import { classifyReviewer } from '../plugins/review-voice/src/github/roles.ts';
import { collectRepository } from '../plugins/review-voice/src/corpus/collect.ts';
import { GitHubClient } from '../plugins/review-voice/src/github/client.ts';
import { openDatabase } from '../plugins/review-voice/src/store/db.ts';
import { databasePath } from '../plugins/review-voice/src/store/paths.ts';
import { storeEvents } from '../plugins/review-voice/src/corpus/store.ts';
import { eventWeight } from '../plugins/review-voice/src/retrieval/weights.ts';
import { buildConsentPlan } from '../plugins/review-voice/src/consent/plan.ts';
import { resolveSyncWindow } from '../plugins/review-voice/src/sync/window.ts';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bundle = join(root, 'plugins/review-voice/dist/review-voice.mjs');
const REPO = 'acme/api';

function repoWithConfig(yaml) {
  const dir = mkdtempSync(join(tmpdir(), 'rv-profiles-'));
  mkdirSync(join(dir, '.review-voice'));
  writeFileSync(join(dir, '.review-voice', 'config.yaml'), yaml);
  return dir;
}

function config(yaml) {
  const dir = repoWithConfig(yaml);
  try {
    return loadConfig(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('without identity.reviewers the corpus is the owner alone', () => {
  const loaded = config('identity:\n  owner_reviewer: your-github-login\n');
  assert.equal(loaded.ownerReviewer, 'your-github-login');
  assert.deepEqual(loaded.reviewers, ['your-github-login']);
});

test('an absent owner defaults to the first reviewer', () => {
  const loaded = config('identity:\n  reviewers: [alice, bob]\n');
  assert.equal(loaded.ownerReviewer, 'alice');
  assert.deepEqual(loaded.reviewers, ['alice', 'bob']);
});

test('an explicit owner stays the authority and always joins the pool', () => {
  const loaded = config('identity:\n  owner_reviewer: your-github-login\n  reviewers: [alice, bob]\n');
  assert.equal(loaded.ownerReviewer, 'your-github-login');
  assert.deepEqual(loaded.reviewers, ['your-github-login', 'alice', 'bob']);
});

test('a malformed reviewers list warns and falls back to the owner', () => {
  const loaded = config('identity:\n  owner_reviewer: your-github-login\n  reviewers: bob\n');
  assert.deepEqual(loaded.reviewers, ['your-github-login']);
  assert.ok(loaded.warnings.some((w) => w.includes('identity.reviewers')));
});

test('no config at all leaves no reviewers', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rv-profiles-'));
  try {
    const loaded = loadConfig(dir);
    assert.equal(loaded.ownerReviewer, null);
    assert.deepEqual(loaded.reviewers, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('every listed reviewer classifies as owner, an unlisted teammate as before', () => {
  const input = { ownerLogin: 'alice', reviewerLogins: ['alice', 'Bob'] };
  assert.equal(classifyReviewer({ ...input, login: 'bob' }), 'owner');
  assert.equal(classifyReviewer({ ...input, login: 'alice' }), 'owner');
  assert.equal(classifyReviewer({ ...input, login: 'dave', teamLogins: ['dave'] }), 'team');
  assert.equal(classifyReviewer({ ...input, login: 'erin', authorAssociation: 'MEMBER' }), 'team');
  assert.equal(classifyReviewer({ ...input, login: 'frank' }), 'external');
  assert.equal(classifyReviewer({ ...input, login: 'release-bot[bot]', accountType: 'Bot' }), 'bot');
});

test('retrieval weights every listed reviewer equally', () => {
  const alice = classifyReviewer({ login: 'alice', ownerLogin: 'alice', reviewerLogins: ['alice', 'bob'] });
  const bob = classifyReviewer({ login: 'bob', ownerLogin: 'alice', reviewerLogins: ['alice', 'bob'] });
  const weigh = (role) =>
    eventWeight({
      role,
      outcome: 'accepted',
      createdAt: '2026-09-01T00:00:00Z',
      specificity: { hasFilePath: true, hasLine: true, hasDiffHunk: true },
      context: { sameRepository: true, samePath: false, sameLanguage: false, differentLanguage: false },
      now: new Date('2026-10-01T00:00:00Z'),
    });
  assert.equal(weigh(alice), weigh(bob));
});

const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const comment = (id, login, body) => ({
  id,
  body,
  user: { login, type: 'User' },
  author_association: 'NONE',
  created_at: '2026-09-01T00:00:00Z',
  path: 'src/a.ts',
  line: 3,
  diff_hunk: '@@ -1,3 +1,3 @@\n-old\n+new',
});

function fakeApi(pulls, comments) {
  return async (url) => {
    const { pathname } = new URL(String(url));
    if (pathname.endsWith('/pulls')) return json(pulls);
    if (/\/pulls\/\d+\/comments$/.test(pathname)) return json(comments);
    return json([]);
  };
}

const emptyStats = () => ({
  pullRequestsScanned: 0,
  pullRequestsUnchanged: 0,
  commentsSeen: 0,
  bySource: { inline: 0, reviewSummary: 0, conversation: 0 },
  eligible: 0,
  duplicates: 0,
  excluded: {},
});

const collectOptions = (extra) => ({
  repository: REPO,
  ownerLogin: 'alice',
  maxPullRequests: 10,
  maxCommentsPerPull: 50,
  includeForks: false,
  includeConversationComments: false,
  ...extra,
});

const pull = (number, updated) => ({ number, html_url: `https://example.com/${number}`, updated_at: updated });
const BOB = 'This returns before the transaction commits, so a retry mints two tokens.';
const ALICE = 'The cache key ignores the tenant, so one tenant can read the other tenant data.';
const DAVE = 'This loop reads the whole table on every request, which will time out at scale.';

test('collection keeps every listed reviewer as owner with their own author', async () => {
  const client = new GitHubClient({
    allowlist: [REPO],
    token: 't',
    sleep: async () => {},
    fetchImpl: fakeApi(
      [pull(1, '2026-09-02T00:00:00Z')],
      [comment(1, 'alice', ALICE), comment(2, 'bob', BOB), comment(3, 'dave', DAVE)],
    ),
  });
  const result = await collectRepository(
    client,
    collectOptions({ reviewerLogins: ['alice', 'bob'], teamLogins: ['dave'] }),
    emptyStats(),
  );
  const byAuthor = Object.fromEntries(result.events.map((e) => [e.reviewerLogin, e.role]));
  assert.deepEqual(byAuthor, { alice: 'owner', bob: 'owner', dave: 'team' });
});

test('without reviewerLogins a teammate is not the owner', async () => {
  const client = new GitHubClient({
    allowlist: [REPO],
    token: 't',
    sleep: async () => {},
    fetchImpl: fakeApi([pull(1, '2026-09-02T00:00:00Z')], [comment(2, 'bob', BOB)]),
  });
  const result = await collectRepository(client, collectOptions({ teamLogins: ['bob'] }), emptyStats());
  assert.deepEqual(result.events.map((e) => e.role), ['team']);
});

test('updatedSince skips older pull requests', async () => {
  const client = new GitHubClient({
    allowlist: [REPO],
    token: 't',
    sleep: async () => {},
    fetchImpl: fakeApi([pull(1, '2026-09-02T00:00:00Z'), pull(2, '2026-01-01T00:00:00Z')], [comment(1, 'alice', ALICE)]),
  });
  const stats = emptyStats();
  const result = await collectRepository(client, collectOptions({ updatedSince: '2026-06-01T00:00:00.000Z' }), stats);
  assert.equal(stats.pullRequestsScanned, 1);
  assert.deepEqual(result.watermarks.map((w) => w.pullNumber), [1]);
});

test('the consent plan lists pooled reviewers only when there are several', () => {
  const base = { ownerLogin: 'alice', repositories: [REPO], targetEvents: 50, storageLocation: '/tmp/x' };
  assert.equal('reviewerLogins' in buildConsentPlan({ ...base, reviewerLogins: ['alice'] }), false);
  assert.deepEqual(buildConsentPlan({ ...base, reviewerLogins: ['alice', 'bob'] }).reviewerLogins, ['alice', 'bob']);
});

test('sync --quick presets target 50 and 90 days, and explicit flags win', () => {
  const now = new Date('2026-10-25T00:00:00.000Z');
  const quick = resolveSyncWindow({ quick: true, target: undefined, since: null }, now);
  assert.equal(quick.target, 50);
  assert.equal(quick.updatedSince, '2026-07-27T00:00:00.000Z');

  const overridden = resolveSyncWindow({ quick: true, target: 20, since: '30d' }, now);
  assert.equal(overridden.target, 20);
  assert.equal(overridden.updatedSince, '2026-09-25T00:00:00.000Z');

  const plain = resolveSyncWindow({ quick: false, target: undefined, since: null }, now);
  assert.deepEqual(plain, { target: null, updatedSince: undefined });
  assert.ok('error' in resolveSyncWindow({ quick: false, target: undefined, since: 'abc' }, now));
});

function run(args, dataDir, cwd) {
  return execFileSync(process.execPath, [bundle, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, REVIEW_VOICE_DATA_DIR: dataDir },
  });
}

const storedEvent = (key, login) => ({
  eventId: `gh_${key}`,
  source: 'github',
  repository: REPO,
  pullNumber: 1,
  pullRequestUrl: 'https://example.com/pull/1',
  commentId: key,
  reviewerLogin: login,
  role: 'owner',
  createdAt: '2026-09-01T00:00:00Z',
  bodyRedacted: 'The retry mints two tokens because the transaction has not committed.',
  filePath: 'src/a.ts',
  lineStart: 3,
  contentKey: key,
  redactionVersion: '1',
  redactionCounts: {},
});

test('an empty corpus: retrieve returns the baseline voice and status says so', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'rv-profiles-data-'));
  const cwd = mkdtempSync(join(tmpdir(), 'rv-profiles-cwd-'));
  try {
    const retrieved = JSON.parse(run(['retrieve', '--text', 'retry mints two tokens'], dataDir, cwd));
    assert.deepEqual(retrieved.precedents, []);
    assert.equal(retrieved.baseline, true);
    const file = readFileSync(join(root, 'plugins/review-voice/templates/voice.baseline.md'), 'utf8');
    assert.equal(retrieved.voice, file.trim());
    assert.ok(![0x2013, 0x2014].some((code) => retrieved.voice.includes(String.fromCharCode(code))));
    assert.match(run(['status'], dataDir, cwd), /^Corpus: baseline voice in use \(no synced history\)$/m);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('a synced corpus: no baseline, authors on precedents, reviewer count in status', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'rv-profiles-data-'));
  const cwd = mkdtempSync(join(tmpdir(), 'rv-profiles-cwd-'));
  try {
    const db = openDatabase(databasePath({ REVIEW_VOICE_DATA_DIR: dataDir }));
    try {
      storeEvents(db, [storedEvent('k1', 'alice'), storedEvent('k2', 'bob')]);
    } finally {
      db.close();
    }
    const retrieved = JSON.parse(run(['retrieve', '--text', 'retry mints two tokens'], dataDir, cwd));
    assert.equal('baseline' in retrieved, false);
    assert.equal('voice' in retrieved, false);
    assert.deepEqual(retrieved.precedents.map((p) => p.reviewerLogin).sort(), ['alice', 'bob']);
    assert.match(run(['status'], dataDir, cwd), /^Corpus: 2 events from 2 reviewer\(s\)$/m);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('sync rejects a malformed --since', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'rv-profiles-data-'));
  const repo = repoWithConfig(`identity:\n  owner_reviewer: your-github-login\nrepositories:\n  include:\n    - ${REPO}\n`);
  try {
    execFileSync('git', ['init', '-q'], { cwd: repo });
    assert.throws(() => run(['sync', '--since', 'soon', '--dry-run'], dataDir, repo), (error) => {
      assert.equal(error.status, 2);
      assert.match(String(error.stderr), /--since/);
      return true;
    });
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});
