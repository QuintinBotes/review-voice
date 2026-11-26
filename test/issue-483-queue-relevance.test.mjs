/**
 * The deterministic relevance check (#483, docs/adr/0038): CODEOWNERS
 * matching, the owned share, each signal on its own, the team-only queue
 * skip, discovery as report-only surface entries, the `relevance` command,
 * and configuration validation. Uses the fake GitHub patterns of
 * test/queue.test.mjs, extended with the files and contents reads.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GitHubClient, NotAllowlisted } from '../plugins/review-voice/src/github/client.ts';
import { ReviewWriter } from '../plugins/review-voice/src/github/writer.ts';
import { loadConfig } from '../plugins/review-voice/src/policy/load.ts';
import { openDatabase } from '../plugins/review-voice/src/store/db.ts';
import { defaultQueueConfig, defaultRelevanceConfig } from '../plugins/review-voice/src/queue/config.ts';
import { buildQueue } from '../plugins/review-voice/src/queue/queue.ts';
import {
  checkRelevance,
  codeownersOwners,
  codeownersPatternMatches,
  parseCodeowners,
} from '../plugins/review-voice/src/queue/relevance.ts';
import { relevanceCommand } from '../plugins/review-voice/src/queue/relevance-command.ts';
import { DEFAULT_VERDICT_POLICY } from '../plugins/review-voice/src/publish/verdict.ts';
import { defaultWatchConfig } from '../plugins/review-voice/src/watch/config.ts';
import { watchCommand } from '../plugins/review-voice/src/watch/command.ts';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
void root;

const ME = 'your-github-login';
const REPO = 'acme/web';
const NOW = new Date('2026-10-25T12:00:00Z');
const sha = (c) => c.repeat(40);
const BASE = sha('b');

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const client = (impl, allowlist = ['acme/*']) =>
  new GitHubClient({ allowlist, allowGlobs: true, token: 't', fetchImpl: impl, sleep: async () => {} });

const item = (repository, number) => ({ number, repository_url: `https://api.github.com/repos/${repository}`, pull_request: {} });

/**
 * A fake GitHub. `search` maps a source name (requested, assigned, team,
 * reviewed, discovered) to result items; `pulls`, `files` and `reviews` are
 * keyed `owner/repo#n`; `codeowners` maps a contents path to its text for
 * every repository. POSTs are answered and kept, as in test/watch.test.mjs.
 */
function fakeGitHub({ search = {}, pulls = {}, files = {}, reviews = {}, codeowners = {}, login = ME } = {}) {
  const calls = [];
  const impl = async (url, init = {}) => {
    const parsed = new URL(String(url));
    const method = init.method ?? 'GET';
    calls.push(`${method} ${parsed.pathname}${parsed.search}`);
    if (parsed.pathname.endsWith('/graphql')) return json({ data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } } });
    if (method === 'POST') return json({ id: 1, html_url: 'https://example.invalid/review/1', state: 'APPROVED' });
    if (parsed.pathname === '/user') return json({ login });
    if (parsed.pathname === '/search/issues') {
      const q = parsed.searchParams.get('q');
      const source = q.includes('user-review-requested:@me')
        ? 'requested'
        : q.includes('assignee:@me')
          ? 'assigned'
          : q.includes('team-review-requested:')
            ? 'team'
            : q.includes('reviewed-by:@me')
              ? 'reviewed'
              : q.includes('repo:') || q.includes('org:')
                ? 'discovered'
                : 'none';
      const items = search[source] ?? [];
      return json({ total_count: items.length, incomplete_results: false, items });
    }
    const contents = /^\/repos\/[^/]+\/[^/]+\/contents\/(.+)$/.exec(parsed.pathname);
    if (contents) {
      const text = codeowners[decodeURIComponent(contents[1])];
      return text === undefined
        ? new Response('not found', { status: 404 })
        : json({ type: 'file', encoding: 'base64', content: Buffer.from(text, 'utf8').toString('base64') });
    }
    const filesMatch = /^\/repos\/([^/]+\/[^/]+)\/pulls\/(\d+)\/files$/.exec(parsed.pathname);
    if (filesMatch) return json(files[`${filesMatch[1]}#${filesMatch[2]}`] ?? []);
    const reviewMatch = /^\/repos\/([^/]+\/[^/]+)\/pulls\/(\d+)\/reviews$/.exec(parsed.pathname);
    if (reviewMatch) return json(reviews[`${reviewMatch[1]}#${reviewMatch[2]}`] ?? []);
    const pullMatch = /^\/repos\/([^/]+\/[^/]+)\/pulls\/(\d+)$/.exec(parsed.pathname);
    if (pullMatch) {
      const found = pulls[`${pullMatch[1]}#${pullMatch[2]}`];
      return found === undefined ? new Response('not found', { status: 404 }) : json(found);
    }
    if (/\/(pulls|issues)\/\d+\/comments$/.test(parsed.pathname)) return json([]);
    if (parsed.pathname.endsWith('/check-runs')) return json({ total_count: 0, check_runs: [] });
    if (parsed.pathname.endsWith('/status')) return json({ state: 'success', total_count: 0, statuses: [] });
    return new Response('not found', { status: 404 });
  };
  impl.calls = calls;
  impl.posts = () => calls.filter((call) => call.startsWith('POST '));
  impl.filesCalls = () => calls.filter((call) => call.includes('/files'));
  return impl;
}

const pull = ({ head = sha('a'), author = 'alice', type = 'User', draft = false, state = 'open', created = '2026-10-01T00:00:00Z', title = 'A change', body = '', assignees = [] } = {}) => ({
  state,
  draft,
  created_at: created,
  title,
  body,
  head: { sha: head },
  base: { sha: BASE },
  user: { login: author, type },
  assignees: assignees.map((login) => ({ login })),
});

const file = (filename, additions, deletions, patch) => ({
  filename,
  additions,
  deletions,
  ...(patch === undefined ? {} : { patch }),
});

const relevanceConfig = (overrides = {}) => ({ ...defaultRelevanceConfig(['acme/platform']), ...overrides });

const check = (impl, { config = relevanceConfig(), pullRequest, maxFiles } = {}) =>
  checkRelevance({
    client: client(impl),
    config,
    repository: REPO,
    pull: 7,
    pullRequest: pullRequest ?? { title: 'A change', body: '', author: 'alice', baseSha: BASE },
    ...(maxFiles === undefined ? {} : { maxFiles }),
  });

function withDb(body) {
  const dir = mkdtempSync(join(tmpdir(), 'rv-483-'));
  const db = openDatabase(join(dir, 'review-voice.db'));
  return Promise.resolve()
    .then(() => body(db))
    .finally(() => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    });
}

const queueConfig = (overrides = {}, relevance = relevanceConfig()) => ({
  ...defaultQueueConfig(),
  teams: ['acme/platform'],
  ...overrides,
  relevance,
});

const queue = (impl, db, cfg, allowlist = ['acme/*']) =>
  buildQueue({ client: client(impl, allowlist), db, config: cfg, me: ME, now: NOW, allowlist });

// --- CODEOWNERS matching ---

test('CODEOWNERS: the last matching line wins, and a line with no owners un-owns', () => {
  const entries = parseCodeowners(
    ['# a comment', '', '* @acme/everyone', 'src/ @acme/platform @alice', 'src/legacy.ts'].join('\n'),
  );
  assert.deepEqual(codeownersOwners(entries, 'README.md'), ['@acme/everyone']);
  assert.deepEqual(codeownersOwners(entries, 'src/app.ts'), ['@acme/platform', '@alice']);
  assert.deepEqual(codeownersOwners(entries, 'src/legacy.ts'), [], 'un-owned, not the earlier match');
});

test('CODEOWNERS: *.js with no slash matches at any depth; comments and blank lines are ignored', () => {
  const entries = parseCodeowners('\n# js owners\n*.js @acme/platform\n');
  assert.equal(entries.length, 1);
  assert.deepEqual(codeownersOwners(entries, 'a/b/c.js'), ['@acme/platform']);
  assert.deepEqual(codeownersOwners(entries, 'top.js'), ['@acme/platform']);
  assert.equal(codeownersOwners(entries, 'a/b/c.ts'), null);
});

test('CODEOWNERS: /docs/ matches only the root docs directory, and ** spans directories', () => {
  assert.equal(codeownersPatternMatches('/docs/', 'docs/guide.md'), true);
  assert.equal(codeownersPatternMatches('/docs/', 'docs/deep/guide.md'), true);
  assert.equal(codeownersPatternMatches('/docs/', 'packages/x/docs/guide.md'), false);
  assert.equal(codeownersPatternMatches('src/**/api/*.ts', 'src/a/b/api/x.ts'), true);
  assert.equal(codeownersPatternMatches('src/**/api/*.ts', 'src/api/x.ts'), true);
  assert.equal(codeownersPatternMatches('src/**/api/*.ts', 'src/a/b/other/x.ts'), false);
  assert.equal(codeownersPatternMatches('docs/', 'packages/x/docs/guide.md'), true, 'a trailing slash alone does not anchor');
});

test('CODEOWNERS: an unanchored pattern ending in a plain segment owns the files beneath it', () => {
  assert.equal(codeownersPatternMatches('**/logs', 'build/logs/a.ts'), true);
  assert.equal(codeownersPatternMatches('**/logs', 'deeply/nested/logs/x/y.ts'), true);
  assert.equal(codeownersPatternMatches('docs/**/logs', 'docs/a/logs/x.ts'), true);
  assert.equal(codeownersPatternMatches('**/*.ts', 'src.ts/a.md'), false);
});

test('CODEOWNERS: a line starting with an escaped # is ignored', () => {
  const entries = parseCodeowners('\\#foo @team\n');
  assert.equal(codeownersOwners(entries, '#foo'), null);
});

// --- the owned share ---

const ownedFiles = [file('src/owned.ts', 20, 10), file('src/other.ts', 70, 0)];
const ownedCodeowners = { '.github/CODEOWNERS': 'src/owned.ts @Acme/Platform\n' };

test('the owned share is the team-owned changed lines over every changed line', async () => {
  const impl = fakeGitHub({ files: { [`${REPO}#7`]: ownedFiles }, codeowners: ownedCodeowners });
  const atPointTwo = await check(impl, { config: relevanceConfig({ minOwnedShare: 0.2 }) });
  assert.equal(atPointTwo.ownedShare, 0.3);
  assert.equal(atPointTwo.relevant, true);
  assert.deepEqual(atPointTwo.signals.map((signal) => signal.kind), ['owned']);
  assert.match(atPointTwo.signals[0].detail, /0\.30/);
  assert.match(atPointTwo.signals[0].detail, /@acme\/platform/i);
  assert.equal(atPointTwo.truncated, false);

  const atPointFive = await check(impl, { config: relevanceConfig({ minOwnedShare: 0.5 }) });
  assert.equal(atPointFive.ownedShare, 0.3);
  assert.equal(atPointFive.relevant, false);
  assert.ok(atPointFive.reasons.join(' ').includes('below min_owned_share'), atPointFive.reasons.join('; '));
});

test('an ignored owned path contributes no owned lines', async () => {
  const impl = fakeGitHub({ files: { [`${REPO}#7`]: ownedFiles }, codeowners: ownedCodeowners });
  const result = await check(impl, { config: relevanceConfig({ ignoreOwnedPaths: ['src/owned.ts'] }) });
  assert.equal(result.ownedShare, 0);
  assert.equal(result.relevant, false);
});

test('missing CODEOWNERS gives an owned share of null with a reason, never an error', async () => {
  const impl = fakeGitHub({ files: { [`${REPO}#7`]: ownedFiles } });
  const result = await check(impl);
  assert.equal(result.ownedShare, null);
  assert.equal(result.relevant, false);
  assert.ok(result.reasons.some((reason) => reason.includes('no CODEOWNERS')), result.reasons.join('; '));
  // All three of GitHub's locations were tried, at the base sha.
  const contents = impl.calls.filter((call) => call.includes('/contents/'));
  assert.equal(contents.length, 3);
  assert.ok(contents.every((call) => call.includes(`ref=${BASE}`)));
});

test('CODEOWNERS is read from the first of GitHub’s locations that exists', async () => {
  const impl = fakeGitHub({
    files: { [`${REPO}#7`]: ownedFiles },
    codeowners: { CODEOWNERS: 'src/owned.ts @acme/platform\n', 'docs/CODEOWNERS': 'src/other.ts @acme/platform\n' },
  });
  const result = await check(impl);
  assert.equal(result.ownedShare, 0.3, 'the root CODEOWNERS wins over docs/');
});

test('a file list at the cap is reported truncated', async () => {
  const impl = fakeGitHub({ files: { [`${REPO}#7`]: ownedFiles }, codeowners: ownedCodeowners });
  const result = await check(impl, { maxFiles: 1 });
  assert.equal(result.truncated, true);
  assert.ok(result.reasons.some((reason) => reason.includes('truncated')));
});

// --- each signal on its own ---

test('a path signal alone makes a pull request relevant, with the glob and file', async () => {
  const impl = fakeGitHub({ files: { [`${REPO}#7`]: [file('docs/guide.md', 5, 0)] } });
  const result = await check(impl, { config: relevanceConfig({ paths: ['docs/**'] }) });
  assert.equal(result.relevant, true);
  assert.deepEqual(result.signals, [{ kind: 'path', detail: 'path docs/** matched docs/guide.md' }]);
});

test('an added-line signal alone is relevant, with the pattern, file and head line', async () => {
  const patch = ['@@ -1,2 +1,3 @@', ' const a = 1;', '+const secretToken = load();', ' const b = 2;'].join('\n');
  const impl = fakeGitHub({ files: { [`${REPO}#7`]: [file('src/app.ts', 1, 0, patch)] } });
  const result = await check(impl, { config: relevanceConfig({ addedLinePatterns: ['SECRETTOKEN'] }) });
  assert.equal(result.relevant, true);
  assert.deepEqual(result.signals, [
    { kind: 'added_line', detail: 'added line pattern SECRETTOKEN matched src/app.ts:2' },
  ]);
  const contextOnly = await check(impl, { config: relevanceConfig({ addedLinePatterns: ['const b'] }) });
  assert.equal(contextOnly.relevant, false, 'a context line is not an added line');
});

test('an author signal alone is relevant, case-insensitively', async () => {
  const impl = fakeGitHub({ files: { [`${REPO}#7`]: [] } });
  const result = await check(impl, { config: relevanceConfig({ authors: ['Alice'] }) });
  assert.equal(result.relevant, true);
  assert.equal(result.signals[0].kind, 'author');
  assert.match(result.signals[0].detail, /@alice/);
});

test('a keyword matches a whole word only, case-insensitively, in title or description', async () => {
  const impl = fakeGitHub({ files: { [`${REPO}#7`]: [] } });
  const config = relevanceConfig({ keywords: ['extract'] });
  const inside = await check(impl, {
    config,
    pullRequest: { title: 'Extraction pipeline cleanup', body: '', author: 'alice', baseSha: BASE },
  });
  assert.equal(inside.relevant, false, 'extract does not match inside extraction');

  const whole = await check(impl, {
    config,
    pullRequest: { title: 'Cleanup', body: 'This Extracts nothing; it does extract the parser.', author: 'alice', baseSha: BASE },
  });
  assert.equal(whole.relevant, true);
  assert.deepEqual(whole.signals, [{ kind: 'keyword', detail: 'keyword "extract" in the title or description' }]);
});

// --- the queue ---

const teamSearch = { team: [item(REPO, 7)] };
const irrelevantFiles = { [`${REPO}#7`]: [file('src/other.ts', 10, 0)] };
const irrelevantCodeowners = { '.github/CODEOWNERS': 'src/other.ts @acme/someone-else\n' };

test('a team-only pull request with no signal is skipped as relevance, with its reasons', async () => {
  const impl = fakeGitHub({
    search: teamSearch,
    pulls: { [`${REPO}#7`]: pull() },
    files: irrelevantFiles,
    codeowners: irrelevantCodeowners,
  });
  await withDb(async (db) => {
    const result = await queue(impl, db, queueConfig({ sources: ['team'] }));
    assert.equal(result.entries.length, 1);
    assert.equal(result.entries[0].action.kind, 'skip');
    assert.equal(result.entries[0].action.rule, 'relevance');
    assert.ok(result.entries[0].action.reasons.length > 0);
    assert.ok(result.entries[0].action.reasons.join(' ').includes('No relevance signal matched.'));
    assert.deepEqual(result.entries[0].sources, ['team']);
  });
});

test('the same pull request with a personal request is reviewed, and no files are read', async () => {
  const impl = fakeGitHub({
    search: { team: [item(REPO, 7)], requested: [item(REPO, 7)] },
    pulls: { [`${REPO}#7`]: pull() },
    files: irrelevantFiles,
    codeowners: irrelevantCodeowners,
  });
  await withDb(async (db) => {
    const result = await queue(impl, db, queueConfig({ sources: ['requested', 'team'] }));
    assert.deepEqual(result.entries.map((entry) => entry.action.kind), ['review']);
    assert.equal(impl.filesCalls().length, 0, 'relevance never runs for a personal request');
  });
});

test('a draft team pull request is skipped as drafts before any files are read', async () => {
  const impl = fakeGitHub({
    search: teamSearch,
    pulls: { [`${REPO}#7`]: pull({ draft: true }) },
    files: irrelevantFiles,
    codeowners: irrelevantCodeowners,
  });
  await withDb(async (db) => {
    const result = await queue(impl, db, queueConfig({ sources: ['team'] }));
    assert.equal(result.entries[0].action.rule, 'drafts');
    assert.equal(impl.filesCalls().length, 0);
    assert.ok(!impl.calls.some((call) => call.includes('/contents/')));
  });
});

test('a relevant team-only pull request is reviewed', async () => {
  const impl = fakeGitHub({
    search: teamSearch,
    pulls: { [`${REPO}#7`]: pull({ title: 'Migrate the billing schema' }) },
    files: irrelevantFiles,
    codeowners: irrelevantCodeowners,
  });
  await withDb(async (db) => {
    const result = await queue(impl, db, queueConfig({ sources: ['team'] }, relevanceConfig({ keywords: ['billing'] })));
    assert.deepEqual(result.entries.map((entry) => entry.action.kind), ['review']);
  });
});

test('without queue.relevance a team pull request is reviewed and no files are read', async () => {
  const impl = fakeGitHub({
    search: teamSearch,
    pulls: { [`${REPO}#7`]: pull() },
    files: irrelevantFiles,
    codeowners: irrelevantCodeowners,
  });
  await withDb(async (db) => {
    const config = { ...defaultQueueConfig(), sources: ['team'], teams: ['acme/platform'] };
    const result = await queue(impl, db, config);
    assert.deepEqual(result.entries.map((entry) => entry.action.kind), ['review']);
    assert.equal(impl.filesCalls().length, 0);
  });
});

// --- discovery ---

const discoverConfig = (overrides = {}) =>
  relevanceConfig({ keywords: ['billing'], discover: { updatedWithinHours: 24, maxPulls: 50 }, ...overrides });

test('a relevant unrequested pull request is surfaced with source discovered, never reviewed', async () => {
  const impl = fakeGitHub({
    search: {
      requested: [item(REPO, 1)],
      discovered: [item(REPO, 1), item(REPO, 9), item(REPO, 10), item('someone/private', 3)],
    },
    pulls: {
      [`${REPO}#1`]: pull({ created: '2026-10-01T00:00:00Z' }),
      [`${REPO}#9`]: pull({ title: 'Rework billing totals', created: '2026-10-02T00:00:00Z' }),
      [`${REPO}#10`]: pull({ title: 'Tidy the readme', created: '2026-10-03T00:00:00Z' }),
    },
    files: { [`${REPO}#9`]: [file('src/a.ts', 4, 0)], [`${REPO}#10`]: [file('src/a.ts', 4, 0)] },
  });
  await withDb(async (db) => {
    const result = await queue(impl, db, queueConfig({ sources: ['requested'] }, discoverConfig()), [REPO]);
    assert.deepEqual(
      result.entries.map((entry) => `${entry.pull}:${entry.action.kind}:${entry.sources.join('+')}`),
      ['1:review:requested', '9:surface:discovered'],
    );
    assert.deepEqual(result.entries[1].action.signals.map((signal) => signal.kind), ['keyword']);
    assert.equal(result.outsideAllowlist, 1, 'the foreign search result is counted and dropped');
    assert.ok(!impl.calls.some((call) => call.includes('someone')), 'nothing further is read about it');
    const searches = impl.calls.filter((call) => call.includes('/search/issues'));
    assert.ok(searches.some((call) => decodeURIComponent(call).includes('repo:acme/web updated:>=2026-10-24T12:00:00Z')));
    assert.ok(searches.some((call) => call.includes('sort=updated&order=desc')));
  });
});

test('discovery drops the owner’s own and skip-rule pull requests without reading files', async () => {
  const impl = fakeGitHub({
    search: { discovered: [item(REPO, 9), item(REPO, 10)] },
    pulls: {
      [`${REPO}#9`]: pull({ title: 'Billing', author: ME }),
      [`${REPO}#10`]: pull({ title: 'Billing', author: 'dependabot[bot]', type: 'Bot' }),
    },
    files: { [`${REPO}#9`]: [file('src/a.ts', 4, 0)], [`${REPO}#10`]: [file('src/a.ts', 4, 0)] },
  });
  await withDb(async (db) => {
    const result = await queue(impl, db, queueConfig({ sources: ['requested'] }, discoverConfig()), [REPO]);
    assert.deepEqual(result.entries, []);
    assert.equal(impl.filesCalls().length, 0);
  });
});

test('discovery considers at most max_pulls pull requests in total', async () => {
  const impl = fakeGitHub({
    search: { discovered: [item(REPO, 9), item(REPO, 10)] },
    pulls: {
      [`${REPO}#9`]: pull({ title: 'Billing one' }),
      [`${REPO}#10`]: pull({ title: 'Billing two' }),
    },
    files: { [`${REPO}#9`]: [file('src/a.ts', 4, 0)], [`${REPO}#10`]: [file('src/a.ts', 4, 0)] },
  });
  await withDb(async (db) => {
    const config = queueConfig({ sources: ['requested'] }, discoverConfig({ discover: { updatedWithinHours: 24, maxPulls: 1 } }));
    const result = await queue(impl, db, config, [REPO]);
    assert.deepEqual(result.entries.map((entry) => entry.pull), [9]);
    assert.ok(!impl.calls.some((call) => call.includes('/pulls/10')), 'the second pull request is never read');
  });
});

test('a surface entry does not count toward max_per_pass', async () => {
  const impl = fakeGitHub({
    search: { requested: [item(REPO, 1)], discovered: [item(REPO, 9)] },
    pulls: {
      [`${REPO}#1`]: pull({ created: '2026-09-30T00:00:00Z' }),
      [`${REPO}#9`]: pull({ title: 'Billing', created: '2026-10-01T00:00:00Z' }),
    },
    files: { [`${REPO}#9`]: [file('src/a.ts', 4, 0)] },
  });
  await withDb(async (db) => {
    const result = await queue(impl, db, queueConfig({ sources: ['requested'], maxPerPass: 1 }, discoverConfig()), [REPO]);
    assert.deepEqual(result.entries.map((entry) => entry.action.kind), ['review', 'surface']);
    assert.deepEqual(result.notReached, []);
  });
});

test('the discovered search source is refused outside the allowlist or without a bound', async () => {
  const impl = fakeGitHub();
  const gh = client(impl, [REPO]);
  await assert.rejects(() => gh.searchPullRequests('discovered:someone/private', { updatedSince: '2026-10-24T12:00:00Z' }), NotAllowlisted);
  await assert.rejects(() => gh.searchPullRequests('discovered:acme/web'), NotAllowlisted);
  await assert.rejects(() => gh.searchPullRequests('discovered:acme/web', { updatedSince: 'yesterday' }), NotAllowlisted);
  assert.equal(impl.calls.length, 0);
});

// --- watch treats a surface entry as report-only ---

test('watch --once prints a surfaced pull request and posts and records nothing for it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rv-483-watch-'));
  const dbPath = join(dir, 'review-voice.db');
  const source = join(dir, 'source-config.yaml');
  writeFileSync(source, 'watch: {}\n');
  const out = [];
  const err = [];
  const impl = fakeGitHub({
    search: { discovered: [item(REPO, 9)] },
    pulls: { [`${REPO}#9`]: pull({ title: 'Rework billing totals' }) },
    files: { [`${REPO}#9`]: [file('src/a.ts', 4, 0)] },
  });
  const reviewCalls = [];
  const prepareCalls = [];
  const config = {
    allowlist: [REPO],
    queue: { ...defaultQueueConfig(), sources: ['requested'], relevance: discoverConfig() },
    watch: { ...defaultWatchConfig() },
    warnings: [],
    postingEnabled: true,
    ciGateChecks: [],
    ciRules: {},
    ownerReviewer: ME,
    verdictPolicy: { ...DEFAULT_VERDICT_POLICY },
  };
  try {
    const code = await watchCommand(['--once', '--post'], {
      configSource: source,
      loadSettings: () => structuredClone(config),
      client: (allowlist) => new GitHubClient({ allowlist, allowGlobs: true, token: 't', fetchImpl: impl, sleep: async () => {} }),
      writerFor: (allowlist) => new ReviewWriter({ allowlist, token: 't', fetchImpl: impl }),
      openDb: () => openDatabase(dbPath),
      dataDir: dir,
      review: async (args) => {
        reviewCalls.push(args);
        return { exitCode: 0, runId: null, event: null, reviewUrl: null, detail: null };
      },
      stopReview: () => {},
      prepareClone: (repository, number, cloneDir) => {
        prepareCalls.push({ repository, number, cloneDir });
        if (!existsSync(join(cloneDir, '.git'))) {
          mkdirSync(cloneDir, { recursive: true });
          execFileSync('git', ['init', '-q', cloneDir]);
        }
      },
      now: () => NOW,
      sleep: async () => {},
      out: (text) => out.push(text),
      err: (text) => err.push(text),
    });
    assert.equal(code, 0, err.join('\n'));
    assert.match(out.join('\n'), /acme\/web#9: surface \(keyword "billing"/);
    assert.equal(reviewCalls.length, 0, 'never reviewed');
    assert.equal(prepareCalls.length, 0, 'no clone prepared');
    assert.equal(impl.posts().length, 0, 'nothing posted');
    const db = openDatabase(dbPath);
    try {
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM watch_heads').get().n, 0, 'nothing recorded as handled');
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- the relevance command ---

test('relevance --pr prints the JSON shape and exits 0 either way; a missing --pr exits 2', async () => {
  const impl = fakeGitHub({
    pulls: { [`${REPO}#7`]: pull() },
    files: { [`${REPO}#7`]: ownedFiles },
    codeowners: ownedCodeowners,
  });
  const out = [];
  const err = [];
  const deps = {
    config: { allowlist: [REPO], queue: queueConfig(), warnings: [] },
    client: (allowlist) => client(impl, allowlist),
    inferRepository: () => REPO,
    out: (text) => out.push(text),
    err: (text) => err.push(text),
  };
  assert.equal(await relevanceCommand(['--pr', '7'], deps), 0);
  const printed = JSON.parse(out.join('\n'));
  assert.deepEqual(Object.keys(printed), ['relevant', 'signals', 'ownedShare', 'truncated', 'reasons']);
  assert.equal(printed.relevant, true);
  assert.equal(printed.ownedShare, 0.3);

  out.length = 0;
  assert.equal(await relevanceCommand([], deps), 2);
  assert.ok(err.join('\n').includes('--pr needs a pull request number.'));
});

test('relevance exits 2 with the status on a 401 or 403 from GitHub; other GitHub errors exit 1', async () => {
  for (const [status, expected, pulls] of [[403, 2, '/pulls/7'], [401, 2, '/pulls/7/files'], [500, 1, '/pulls/7']]) {
    const inner = fakeGitHub({ pulls: { [`${REPO}#7`]: pull() }, files: { [`${REPO}#7`]: ownedFiles }, codeowners: ownedCodeowners });
    const impl = async (url, init) =>
      new URL(String(url)).pathname.endsWith(pulls) ? new Response('nope', { status }) : inner(url, init);
    const err = [];
    const deps = {
      config: { allowlist: [REPO], queue: queueConfig(), warnings: [] },
      client: (allowlist) => client(impl, allowlist),
      inferRepository: () => REPO,
      out: () => {},
      err: (text) => err.push(text),
    };
    let code;
    try {
      code = await relevanceCommand(['--pr', '7'], deps);
    } catch {
      code = 1;
    }
    assert.equal(code, expected, `status ${status}`);
    if (expected === 2) assert.ok(err.join('\n').includes(String(status)), err.join('\n'));
  }
});

// --- configuration ---

test('an invalid regular expression and a share of 1.5 are ignored with warnings naming the key', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rv-483-config-'));
  try {
    mkdirSync(join(dir, '.review-voice'));
    writeFileSync(
      join(dir, '.review-voice', 'config.yaml'),
      [
        'queue:',
        '  teams: [acme/platform]',
        '  relevance:',
        '    min_owned_share: 1.5',
        "    added_line_patterns: ['token', '(']",
        '    keywords: [billing]',
        '    discover: { updated_within_hours: 0, max_pulls: 10 }',
      ].join('\n'),
    );
    const loaded = loadConfig(dir);
    assert.equal(loaded.queue.relevance.minOwnedShare, 0.2, 'the default stands');
    assert.deepEqual(loaded.queue.relevance.addedLinePatterns, ['token']);
    assert.deepEqual(loaded.queue.relevance.teams, ['acme/platform'], 'teams default to queue.teams');
    assert.deepEqual(loaded.queue.relevance.discover, { updatedWithinHours: 24, maxPulls: 10 });
    const warnings = loaded.warnings.join('\n');
    assert.ok(warnings.includes('queue.relevance.min_owned_share'), warnings);
    assert.ok(warnings.includes('queue.relevance.added_line_patterns'), warnings);
    assert.ok(warnings.includes('queue.relevance.discover.updated_within_hours'), warnings);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('with no queue.relevance block the loaded queue has no relevance configuration', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rv-483-config-'));
  try {
    mkdirSync(join(dir, '.review-voice'));
    writeFileSync(join(dir, '.review-voice', 'config.yaml'), 'repositories:\n  include: [acme/web]\n');
    assert.deepEqual(loadConfig(dir).queue, defaultQueueConfig());
    assert.equal(loadConfig(dir).queue.relevance, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
