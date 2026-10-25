/**
 * The queue (docs/adr/0026): owner globs in the allowlist, the one search read
 * outside a repository path with its query built from a typed source, results
 * outside the allowlist dropped unread, skip rules, follow-ups and dismissals
 * from the store, and the `queue` command's output.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GitHubClient, NotAllowlisted, allowlistEntryProblem } from '../plugins/review-voice/src/github/client.ts';
import { loadConfig } from '../plugins/review-voice/src/policy/load.ts';
import { openDatabase } from '../plugins/review-voice/src/store/db.ts';
import { recordAudit } from '../plugins/review-voice/src/store/audit.ts';
import { defaultQueueConfig } from '../plugins/review-voice/src/queue/config.ts';
import { buildQueue } from '../plugins/review-voice/src/queue/queue.ts';
import { queueCommand, renderQueue } from '../plugins/review-voice/src/queue/command.ts';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bundle = join(root, 'plugins/review-voice/dist/review-voice.mjs');

const ME = 'your-github-login';
const NOW = new Date('2026-10-25T12:00:00Z');
const sha = (c) => c.repeat(40);

const json = (body, headers = {}) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json', ...headers } });

const client = (impl, allowlist = ['acme/*'], options = {}) =>
  new GitHubClient({ allowlist, allowGlobs: true, token: 't', fetchImpl: impl, sleep: async () => {}, ...options });

/** A search result item as GitHub returns it. */
const item = (repository, number) => ({ number, repository_url: `https://api.github.com/repos/${repository}`, pull_request: {} });

/**
 * A fake GitHub. `search` maps the qualifier after the fixed prefix to result
 * items; `pulls` and `reviews` are keyed `owner/repo#n`.
 */
function fakeGitHub({ search = {}, pulls = {}, reviews = {}, login = ME } = {}) {
  const calls = [];
  const impl = async (url) => {
    const parsed = new URL(String(url));
    calls.push(parsed.pathname + parsed.search);
    if (parsed.pathname === '/user') return json({ login });
    if (parsed.pathname === '/search/issues') {
      const q = parsed.searchParams.get('q');
      const qualifier = q.replace('is:pr is:open draft:false ', '');
      const items = search[qualifier] ?? [];
      return json({ total_count: items.length, incomplete_results: false, items });
    }
    const reviewMatch = /^\/repos\/([^/]+\/[^/]+)\/pulls\/(\d+)\/reviews$/.exec(parsed.pathname);
    if (reviewMatch) return json(reviews[`${reviewMatch[1]}#${reviewMatch[2]}`] ?? []);
    const pullMatch = /^\/repos\/([^/]+\/[^/]+)\/pulls\/(\d+)$/.exec(parsed.pathname);
    if (pullMatch) {
      const pull = pulls[`${pullMatch[1]}#${pullMatch[2]}`];
      return pull === undefined ? new Response('not found', { status: 404 }) : json(pull);
    }
    return new Response('not found', { status: 404 });
  };
  impl.calls = calls;
  return impl;
}

const pull = ({ head = sha('a'), author = 'alice', type = 'User', draft = false, state = 'open', created = '2026-10-01T00:00:00Z', assignees = [] } = {}) => ({
  state,
  draft,
  created_at: created,
  head: { sha: head },
  user: { login: author, type },
  assignees: assignees.map((login) => ({ login })),
});

function withDb(body) {
  const dir = mkdtempSync(join(tmpdir(), 'rv-queue-'));
  const db = openDatabase(join(dir, 'review-voice.db'));
  return Promise.resolve()
    .then(() => body(db))
    .finally(() => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    });
}

function insertRun(db, { repository = 'acme/web', pull: number = 1, head = sha('a'), createdAt = '2026-10-20T00:00:00Z' } = {}) {
  db.prepare(
    `INSERT INTO review_runs (review_run_id, repository, base_ref, head_ref, diff_hash, active_policy_versions_json,
       retrieved_precedents_json, candidates_json, output_json, created_at, pull_number)
     VALUES (?, ?, NULL, ?, 'h', '[]', '[]', '[]', '', ?, ?)`,
  ).run(`run-${repository}-${number}-${head.slice(0, 4)}-${createdAt}`, repository, head, createdAt, number);
}

const sent = (db, { repository = 'acme/web', pull: number = 1, head = sha('a'), event = 'APPROVE', ...rest } = {}) =>
  recordAudit(db, 'review_post_sent', { type: 'pull_request', id: `${repository}#${number}` }, { head, event, inline: [], ...rest });

const config = (overrides = {}, skip = {}) => {
  const base = defaultQueueConfig();
  return { ...base, ...overrides, skip: { ...base.skip, ...skip } };
};

const queue = (impl, db, cfg = config(), allowlist) =>
  buildQueue({ client: client(impl, allowlist), db, config: cfg, me: ME, now: NOW });

const summary = (result) => result.entries.map((e) => `${e.action.kind}${e.action.rule ? `:${e.action.rule}` : ''} ${e.repository}#${e.pull}`);

// --- allowlist globs ---

test('an owner glob allows every repository of that owner, case-insensitively, and no other', async () => {
  const impl = fakeGitHub({ pulls: { 'ACME/anything#1': pull() } });
  const gh = client(impl, ['Acme/*']);
  await gh.get('/repos/ACME/anything/pulls/1');
  await assert.rejects(() => gh.get('/repos/acme-labs/web/pulls/1'), NotAllowlisted);
  await assert.rejects(() => gh.get('/repos/someone/acme/pulls/1'), NotAllowlisted);
  assert.equal(impl.calls.length, 1);
  assert.equal(gh.allows('acme/web'), true);
  assert.equal(gh.allows('acme'), false);
  assert.equal(gh.allows('acme/web/extra'), false);
  assert.equal(gh.allows('acme/*'), false);
  await assert.rejects(() => gh.get('/repos/acme/*/pulls'), NotAllowlisted);
  await assert.rejects(() => gh.get('/repos/acme/web%2F..%2Fx/pulls'), NotAllowlisted);
});

test('only a client built with allowGlobs accepts owner/*; every other client refuses a pattern', () => {
  const plain = (allowlist) => new GitHubClient({ allowlist, token: 't', fetchImpl: async () => json({}) });
  assert.throws(() => plain(['acme/*']), NotAllowlisted);
  assert.throws(() => plain(['acme/web', 'acme-labs/*']), NotAllowlisted);
  assert.equal(plain(['acme/web']).allows('acme/web'), true);
  assert.equal(client(async () => json({}), ['acme/*']).allows('acme/web'), true);
});

test('a bare *, */* or a glob anywhere but the repository is refused at construction', () => {
  for (const entry of ['*', '*/*', '*/web', 'acme/web-*', 'ac*/web', 'acme/*/x', '/*']) {
    assert.throws(() => client(async () => json({}), [entry]), NotAllowlisted, entry);
    assert.notEqual(allowlistEntryProblem(entry), null, entry);
  }
  assert.equal(allowlistEntryProblem('acme/*'), null);
  assert.equal(allowlistEntryProblem('acme/web'), null);
  assert.notEqual(allowlistEntryProblem('acme'), null);
});

test('repositories.include keeps exact entries and owner globs, and drops anything else with a warning', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rv-queue-config-'));
  try {
    mkdirSync(join(dir, '.review-voice'));
    writeFileSync(
      join(dir, '.review-voice', 'config.yaml'),
      'repositories:\n  include: [acme/web, acme-labs/*, "*", "*/*", acme/web-*, just-a-name]\n',
    );
    const loaded = loadConfig(dir);
    assert.deepEqual(loaded.allowlist, ['acme/web', 'acme-labs/*']);
    assert.equal(loaded.warnings.filter((w) => w.startsWith('repositories.include')).length, 4);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the queue config is read with defaults, and bad values fall back with a warning', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rv-queue-config-'));
  try {
    mkdirSync(join(dir, '.review-voice'));
    const write = (text) => writeFileSync(join(dir, '.review-voice', 'config.yaml'), text);

    write('repositories:\n  include: [acme/web]\n');
    assert.deepEqual(loadConfig(dir).queue, defaultQueueConfig());

    write(
      [
        'queue:',
        '  sources: [requested, nonsense]',
        '  teams: [acme/platform, "bad team", acme]',
        '  max_per_pass: 0',
        '  follow_up_days: 7',
        '  skip:',
        '    authors: [Carol]',
        "    author_patterns: ['^release-', '(']",
        '    allow_bots_when_requested: maybe',
        '    assigned_to: [dave]',
        '    approved_at_head_by: { logins: [release-bot], sources: [team, assigned] }',
        '    drafts: false',
      ].join('\n'),
    );
    const loaded = loadConfig(dir);
    assert.deepEqual(loaded.queue, {
      sources: ['requested'],
      teams: ['acme/platform'],
      maxPerPass: 20,
      followUpDays: 7,
      skip: {
        authors: ['Carol'],
        authorPatterns: ['^release-'],
        allowBotsWhenRequested: true,
        assignedTo: ['dave'],
        approvedAtHeadBy: { logins: ['release-bot'], sources: ['team', 'assigned'] },
        drafts: false,
      },
    });
    const warnings = loaded.warnings.join('\n');
    for (const key of ['queue.sources', 'queue.teams', 'queue.max_per_pass', 'queue.skip.author_patterns', 'queue.skip.allow_bots_when_requested']) {
      assert.ok(warnings.includes(key), `${key} warned`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- the search read ---

test('get refuses a search, relative or absolute; only searchPullRequests sends one', async () => {
  const impl = fakeGitHub();
  const gh = client(impl);
  await assert.rejects(() => gh.get('/search/issues?q=repo:someone/private'), NotAllowlisted);
  await assert.rejects(() => gh.get('https://api.github.com/search/issues?q=x'), NotAllowlisted);
  await assert.rejects(() => gh.get('/SEARCH/code?q=x'), NotAllowlisted);
  await assert.rejects(() => gh.paginate('/search/issues?q=x', 10), NotAllowlisted);
  assert.equal(impl.calls.length, 0);
  // Other reads outside a repository path work as before.
  await gh.get('/user');
  assert.deepEqual(impl.calls, ['/user']);
});

test('a pagination link to a repository outside the allowlist is refused like the path itself', async () => {
  const impl = fakeGitHub();
  await assert.rejects(() => client(impl).get('https://api.github.com/repos/someone/private/pulls'), NotAllowlisted);
  assert.equal(impl.calls.length, 0);
});

test('the credential goes only to the API origin, for a path or a link', async () => {
  const impl = fakeGitHub();
  const gh = client(impl);
  for (const path of ['https://evil.example/repos/acme/web/pulls', 'http://api.github.com/repos/acme/web/pulls', '@evil.example/repos/acme/web']) {
    await assert.rejects(() => gh.get(path), NotAllowlisted, path);
  }
  assert.equal(impl.calls.length, 0);

  const urls = [];
  const linked = async (url) => {
    urls.push(String(url));
    return urls.length === 1 ? json([{ id: 1 }], { link: '<https://evil.example/repos/acme/web/pulls?page=2>; rel="next"' }) : json([{ id: 2 }]);
  };
  assert.deepEqual((await client(linked).paginate('/repos/acme/web/pulls', 10)).map((i) => i.id), [1, 2]);
  assert.deepEqual(urls, ['https://api.github.com/repos/acme/web/pulls', 'https://api.github.com/repos/acme/web/pulls?page=2']);

  const ghes = [];
  const server = client(async (url) => (ghes.push(String(url)), json([])), ['acme/web'], { baseUrl: 'https://ghe.example/api/v3' });
  await server.get('/repos/acme/web/pulls');
  await assert.rejects(() => server.get('https://ghe.example/other/repos/acme/web/pulls'), NotAllowlisted);
  assert.deepEqual(ghes, ['https://ghe.example/api/v3/repos/acme/web/pulls']);
});

test('a dot segment or an encoded dot or slash cannot step out of an allowlisted repository', async () => {
  const impl = async (url) => (impl.calls.push(String(url)), json([]));
  impl.calls = [];
  const gh = client(impl, ['acme/web']);
  for (const path of [
    '/repos/acme/web/../../someone/private/pulls',
    '/repos/acme/web/%2e%2e/%2E%2E/someone/private/pulls',
    '/repos/acme/web%2F..%2F..%2Fsomeone%2Fprivate/pulls',
    '/repos/acme/web/./pulls',
    '/repos/acme/web\\..\\x',
    'https://api.github.com/repos/acme/web/../../someone/private',
  ]) {
    await assert.rejects(() => gh.get(path), NotAllowlisted, path);
  }
  assert.equal(impl.calls.length, 0);
  // An encoded slash in the query is not a path.
  await gh.get('/repos/acme/web/pulls?head=acme%2Fbranch');
  assert.equal(impl.calls.length, 1);
});

test('a repository addressed by id is refused, and an id-form link is followed on the named path', async () => {
  const impl = fakeGitHub();
  await assert.rejects(() => client(impl, ['acme/web']).get('/repositories/123/pulls'), NotAllowlisted);
  assert.equal(impl.calls.length, 0);

  const urls = [];
  const linked = async (url) => {
    urls.push(String(url));
    return urls.length === 1
      ? json({ total_count: 2, check_runs: [{ id: 1 }] }, { link: '<https://api.github.com/repositories/123/commits/abc/check-runs?filter=latest&page=2>; rel="next"' })
      : json({ total_count: 2, check_runs: [{ id: 2 }] });
  };
  const items = await client(linked, ['acme/web']).paginateWrapped('/repos/acme/web/commits/abc/check-runs?filter=latest', 'check_runs', 10);
  assert.deepEqual(items.map((i) => i.id), [1, 2]);
  assert.equal(urls[1], 'https://api.github.com/repos/acme/web/commits/abc/check-runs?filter=latest&page=2');
});

test('each source builds its own query, and no caller text reaches q', async () => {
  const queries = [];
  const impl = async (url) => {
    const parsed = new URL(String(url));
    queries.push(Object.fromEntries(parsed.searchParams));
    return json({ total_count: 0, items: [] });
  };
  const gh = client(impl);
  await gh.searchPullRequests('requested');
  await gh.searchPullRequests('assigned');
  await gh.searchPullRequests('reviewed');
  await gh.searchPullRequests('team:acme/platform-team');
  assert.deepEqual(
    queries.map((q) => q.q),
    [
      'is:pr is:open draft:false user-review-requested:@me',
      'is:pr is:open draft:false assignee:@me',
      'is:pr is:open draft:false reviewed-by:@me',
      'is:pr is:open draft:false team-review-requested:acme/platform-team',
    ],
  );
  for (const q of queries) assert.deepEqual({ sort: q.sort, order: q.order, per_page: q.per_page, page: q.page }, { sort: 'created', order: 'asc', per_page: '100', page: '1' });
});

test('a team source must be org/slug; anything else is refused before a request', async () => {
  const impl = fakeGitHub();
  const gh = client(impl);
  for (const source of [
    'team:acme',
    'team:acme/plat form',
    'team:acme/x/y',
    'team:-acme/x',
    'team:acme/x repo:someone/private',
    'team:acme/x+is:closed',
    'is:pr repo:someone/private',
    'requested repo:someone/private',
    '',
  ]) {
    await assert.rejects(() => gh.searchPullRequests(source), NotAllowlisted, source);
  }
  assert.equal(impl.calls.length, 0);
});

test('a result outside the allowlist is counted and dropped, and never read further', async () => {
  const impl = fakeGitHub({
    search: { 'user-review-requested:@me': [item('acme/web', 1), item('someone/private', 2), item('Acme/api', 3)] },
    pulls: { 'acme/web#1': pull(), 'Acme/api#3': pull({ created: '2026-10-02T00:00:00Z' }) },
  });
  await withDb(async (db) => {
    const result = await queue(impl, db, config({ sources: ['requested'] }));
    assert.equal(result.outsideAllowlist, 1);
    assert.deepEqual(summary(result), ['review acme/web#1', 'review Acme/api#3']);
    assert.ok(impl.calls.every((call) => !call.includes('someone')), impl.calls.join('\n'));
  });
});

test('search reads at most five pages and reports truncation', async () => {
  let page = 0;
  const impl = async (url) => {
    page = Number(new URL(String(url)).searchParams.get('page'));
    const items = Array.from({ length: 100 }, (_, i) => item('acme/web', page * 100 + i));
    return json({ total_count: 900, items });
  };
  const result = await client(impl).searchPullRequests('requested');
  assert.equal(page, 5);
  assert.equal(result.pullRequests.length, 500);
  assert.equal(result.truncated, true);

  const short = await client(async () => json({ total_count: 2, items: [item('acme/web', 1), item('acme/web', 2)] })).searchPullRequests('assigned');
  assert.equal(short.truncated, false);
  assert.equal(short.pullRequests.length, 2);

  const incomplete = await client(async () => json({ total_count: 1, incomplete_results: true, items: [item('acme/web', 1)] })).searchPullRequests('assigned');
  assert.equal(incomplete.truncated, true);
});

// --- skip rules ---

test('each skip rule names itself', async () => {
  const pulls = {
    'acme/web#1': pull({ author: ME }),
    'acme/web#2': pull({ author: 'CAROL' }),
    'acme/web#3': pull({ author: 'dependabot[bot]' }),
    'acme/web#4': pull({ author: 'deploy-service', type: 'Bot' }),
    'acme/web#5': pull({ assignees: ['someone', 'Dave'] }),
    'acme/web#6': pull({ draft: true }),
    'acme/web#7': pull(),
    'acme/web#8': pull({ author: 'talbot' }),
    'acme/web#9': pull({ author: 'deploy-bot' }),
  };
  const impl = fakeGitHub({ search: { 'assignee:@me': Object.keys(pulls).map((k) => item('acme/web', Number(k.split('#')[1]))) }, pulls });
  await withDb(async (db) => {
    const result = await queue(impl, db, config({ sources: ['assigned'] }, { authors: ['carol'], assignedTo: ['dave'] }));
    assert.deepEqual(summary(result), [
      'skip:own acme/web#1',
      'skip:authors acme/web#2',
      'skip:author_patterns acme/web#3',
      'skip:author_patterns acme/web#4',
      'skip:assigned_to acme/web#5',
      'skip:drafts acme/web#6',
      'review acme/web#7',
      'review acme/web#8',
      'skip:author_patterns acme/web#9',
    ]);
  });
});

test('a bot that requested the owner personally is let through, unless that is turned off', async () => {
  const impl = fakeGitHub({
    search: { 'user-review-requested:@me': [item('acme/web', 1), item('acme/web', 2)] },
    pulls: { 'acme/web#1': pull({ author: 'renovate-runner' }), 'acme/web#2': pull({ author: 'ci', type: 'Bot' }) },
  });
  await withDb(async (db) => {
    assert.deepEqual(summary(await queue(impl, db, config({ sources: ['requested'] }))), ['review acme/web#1', 'review acme/web#2']);
    assert.deepEqual(summary(await queue(impl, db, config({ sources: ['requested'] }, { allowBotsWhenRequested: false }))), [
      'skip:author_patterns acme/web#1',
      'skip:author_patterns acme/web#2',
    ]);
  });
});

test('drafts: false lists a draft follow-up', async () => {
  const impl = fakeGitHub({ pulls: { 'acme/web#1': pull({ draft: true, head: sha('b') }) } });
  await withDb(async (db) => {
    insertRun(db, { head: sha('a') });
    assert.deepEqual(summary(await queue(impl, db, config({ sources: ['follow-up'] }))), ['skip:drafts acme/web#1']);
    assert.deepEqual(summary(await queue(impl, db, config({ sources: ['follow-up'] }, { drafts: false }))), ['review acme/web#1']);
  });
});

test('approved_at_head_by applies only to its sources and only at the current head', async () => {
  const head = sha('c');
  const impl = fakeGitHub({
    search: {
      'team-review-requested:acme/platform': [item('acme/web', 1), item('acme/web', 2), item('acme/web', 4), item('acme/web', 5)],
      'user-review-requested:@me': [item('acme/web', 3)],
    },
    pulls: { 'acme/web#1': pull({ head }), 'acme/web#2': pull({ head }), 'acme/web#3': pull({ head }), 'acme/web#4': pull({ head }), 'acme/web#5': pull({ head }) },
    reviews: {
      'acme/web#1': [{ state: 'APPROVED', commit_id: head, user: { login: 'Release-Bot' } }],
      'acme/web#2': [{ state: 'APPROVED', commit_id: sha('d'), user: { login: 'release-bot' } }],
      'acme/web#3': [{ state: 'APPROVED', commit_id: head, user: { login: 'release-bot' } }],
      // A later request for changes withdraws the approval, at the same head.
      'acme/web#4': [
        { state: 'APPROVED', commit_id: head, user: { login: 'release-bot' } },
        { state: 'CHANGES_REQUESTED', commit_id: head, user: { login: 'release-bot' } },
      ],
      // A later plain comment or pending review does not.
      'acme/web#5': [
        { state: 'APPROVED', commit_id: head, user: { login: 'release-bot' } },
        { state: 'COMMENTED', commit_id: head, user: { login: 'release-bot' } },
        { state: 'PENDING', commit_id: head, user: { login: 'release-bot' } },
      ],
    },
  });
  await withDb(async (db) => {
    const result = await queue(
      impl,
      db,
      config({ sources: ['requested', 'team'], teams: ['acme/platform'] }, { approvedAtHeadBy: { logins: ['release-bot'], sources: ['team'] } }),
    );
    assert.deepEqual(summary(result), [
      'skip:approved_at_head_by acme/web#1',
      'review acme/web#2',
      'review acme/web#3',
      'review acme/web#4',
      'skip:approved_at_head_by acme/web#5',
    ]);
    // Reviews are read only where the rule applies.
    assert.ok(!impl.calls.some((call) => call.includes('/pulls/3/reviews')));
  });
});

// --- follow-ups and dismissals ---

test('a follow-up is a recent run whose head moved; an unmoved, old, closed or unlisted one is not', async () => {
  const impl = fakeGitHub({
    pulls: {
      'acme/web#1': pull({ head: sha('b') }),
      'acme/web#2': pull({ head: sha('a') }),
      'acme/web#3': pull({ head: sha('b') }),
      'acme/web#4': pull({ head: sha('b'), state: 'closed' }),
    },
  });
  await withDb(async (db) => {
    insertRun(db, { pull: 1, head: sha('a') });
    insertRun(db, { pull: 2, head: sha('a') });
    insertRun(db, { pull: 3, head: sha('a'), createdAt: '2026-08-01T00:00:00Z' });
    insertRun(db, { pull: 4, head: sha('a') });
    insertRun(db, { repository: 'someone/private', pull: 9, head: sha('a') });
    const result = await queue(impl, db, config({ sources: ['follow-up'] }));
    assert.deepEqual(summary(result), ['review acme/web#1']);
    assert.deepEqual(result.entries[0].sources, ['follow-up']);
    assert.ok(!impl.calls.some((call) => call.includes('/pulls/3') || call.includes('someone')));
  });
});

test('dismissed lists a pull request whose latest own review was dismissed', async () => {
  const impl = fakeGitHub({
    search: { 'reviewed-by:@me': [item('acme/web', 1), item('acme/web', 2)] },
    pulls: { 'acme/web#1': pull(), 'acme/web#2': pull() },
    reviews: {
      'acme/web#1': [
        { state: 'COMMENTED', user: { login: ME } },
        { state: 'DISMISSED', user: { login: 'Your-GitHub-Login' } },
        { state: 'APPROVED', user: { login: 'someone-else' } },
      ],
      'acme/web#2': [
        { state: 'DISMISSED', user: { login: ME } },
        { state: 'APPROVED', user: { login: ME } },
      ],
    },
  });
  await withDb(async (db) => {
    const result = await queue(impl, db, config({ sources: ['dismissed'] }));
    assert.deepEqual(summary(result), ['review acme/web#1']);
    assert.deepEqual(result.entries[0].sources, ['dismissed']);
    assert.ok(!impl.calls.some((call) => /\/pulls\/2$/.test(call)), 'a pull request that is not dismissed is not read');
  });
});

test('sources merge across searches into one entry', async () => {
  const impl = fakeGitHub({
    search: { 'user-review-requested:@me': [item('acme/web', 1)], 'assignee:@me': [item('ACME/WEB', 1)] },
    pulls: { 'acme/web#1': pull({ head: sha('b') }) },
  });
  await withDb(async (db) => {
    insertRun(db, { pull: 1, head: sha('a') });
    const result = await queue(impl, db, config());
    assert.equal(result.entries.length, 1);
    assert.deepEqual(result.entries[0].sources, ['requested', 'assigned', 'follow-up']);
  });
});

// --- actions ---

test('action: review, verdict-only, recheck-ci, or not listed once sent', async () => {
  const head = sha('e');
  const pulls = Object.fromEntries([1, 2, 3, 4, 5].map((n) => [`acme/web#${n}`, pull({ head, created: `2026-10-0${n}T00:00:00Z` })]));
  const impl = fakeGitHub({ search: { 'user-review-requested:@me': [1, 2, 3, 4, 5].map((n) => item('acme/web', n)) }, pulls });
  await withDb(async (db) => {
    // 1: nothing recorded. 2: a run at the head, nothing sent.
    insertRun(db, { pull: 2, head });
    // 3: sent at the head.
    insertRun(db, { pull: 3, head });
    sent(db, { pull: 3, head, event: 'APPROVE' });
    // 4: a COMMENT capped by red CI.
    insertRun(db, { pull: 4, head });
    sent(db, { pull: 4, head, event: 'COMMENT', cappedByCi: true });
    // 5: sent only at an earlier head.
    insertRun(db, { pull: 5, head: sha('f') });
    sent(db, { pull: 5, head: sha('f'), event: 'APPROVE' });
    const result = await queue(impl, db, config({ sources: ['requested'] }));
    assert.deepEqual(summary(result), ['review acme/web#1', 'verdict-only acme/web#2', 'recheck-ci acme/web#4', 'review acme/web#5']);
  });
});

test('an approval sent after a capped COMMENT at the same head takes it off the queue', async () => {
  const head = sha('e');
  const impl = fakeGitHub({ search: { 'user-review-requested:@me': [item('acme/web', 1)] }, pulls: { 'acme/web#1': pull({ head }) } });
  await withDb(async (db) => {
    insertRun(db, { head });
    sent(db, { head, event: 'COMMENT', cappedByCi: true });
    sent(db, { head, event: 'APPROVE' });
    assert.deepEqual(summary(await queue(impl, db, config({ sources: ['requested'] }))), []);
  });
});

// --- order and limit ---

test('oldest first; at most max_per_pass review entries, the rest not reached; others always listed', async () => {
  const created = { 1: '2026-10-05', 2: '2026-10-01', 3: '2026-10-03', 4: '2026-10-04', 5: '2026-10-09' };
  const pulls = Object.fromEntries(
    Object.entries(created).map(([n, day]) => [`acme/web#${n}`, pull({ created: `${day}T00:00:00Z`, author: n === '5' ? 'carol' : 'alice' })]),
  );
  const impl = fakeGitHub({ search: { 'user-review-requested:@me': Object.keys(created).map((n) => item('acme/web', Number(n))) }, pulls });
  await withDb(async (db) => {
    const result = await queue(impl, db, config({ sources: ['requested'], maxPerPass: 2 }, { authors: ['carol'] }));
    assert.deepEqual(summary(result), ['review acme/web#2', 'review acme/web#3', 'skip:authors acme/web#5']);
    assert.deepEqual(result.notReached.map((e) => e.pull), [4, 1]);
  });
});

// --- the command ---

function commandDeps(impl, db, { allowlist = ['acme/*'], queueConfig = config() } = {}) {
  const out = [];
  const err = [];
  return {
    out,
    err,
    deps: {
      config: { allowlist, queue: queueConfig, warnings: [] },
      client: (list) => client(impl, list),
      openDb: () => db,
      now: NOW,
      out: (text) => out.push(text),
      err: (text) => err.push(text),
    },
  };
}

/** The command closes the store it opened; a test store must survive that. */
const keepOpen = (db) => ({ prepare: (...args) => db.prepare(...args), close: () => {} });

test('queue prints one line per entry and a totals line (unit-level: the bundle cannot take a stubbed fetch)', async () => {
  const head = sha('1');
  const impl = fakeGitHub({
    search: { 'user-review-requested:@me': [item('acme/web', 1), item('acme/web', 2), item('someone/x', 3)] },
    pulls: { 'acme/web#1': pull({ head }), 'acme/web#2': pull({ author: 'carol', created: '2026-10-02T00:00:00Z' }) },
  });
  await withDb(async (db) => {
    const { out, err, deps } = commandDeps(impl, keepOpen(db), { queueConfig: config({ sources: ['requested', 'assigned'] }, { authors: ['carol'] }) });
    assert.equal(await queueCommand(['--source', 'requested'], deps), 0, err.join('\n'));
    assert.equal(
      out.join('\n'),
      [
        `REVIEW acme/web#1 1111111 @alice [requested]`,
        `SKIP acme/web#2 ${sha('a').slice(0, 7)} @carol [requested] (authors)`,
        '2 listed, 0 not reached, 1 outside the allowlist, truncated: no',
      ].join('\n'),
    );
    // --source narrowed the searches to the one named.
    assert.ok(!impl.calls.some((call) => call.includes('assignee')));
  });
});

test('queue --json prints the QueueResult', async () => {
  const impl = fakeGitHub({ search: { 'user-review-requested:@me': [item('acme/web', 1)] }, pulls: { 'acme/web#1': pull() } });
  await withDb(async (db) => {
    const { out, deps } = commandDeps(impl, keepOpen(db), { queueConfig: config({ sources: ['requested'] }) });
    assert.equal(await queueCommand(['--json', '--max', '5'], deps), 0);
    const result = JSON.parse(out.join('\n'));
    assert.deepEqual(Object.keys(result), ['entries', 'notReached', 'outsideAllowlist', 'truncated']);
    assert.deepEqual(result.entries[0], {
      repository: 'acme/web',
      pull: 1,
      head: sha('a'),
      author: 'alice',
      sources: ['requested'],
      action: { kind: 'review' },
      createdAt: '2026-10-01T00:00:00Z',
    });
  });
});

test('renderQueue labels every action', () => {
  const entry = (kind, rule) => ({ repository: 'acme/web', pull: 1, head: sha('a'), author: 'alice', sources: ['assigned'], action: rule ? { kind, rule } : { kind }, createdAt: '' });
  const text = renderQueue({ entries: [entry('verdict-only'), entry('recheck-ci')], notReached: [entry('review')], outsideAllowlist: 0, truncated: true });
  assert.match(text, /^VERDICT-ONLY acme\/web#1 aaaaaaa @alice \[assigned\]$/m);
  assert.match(text, /^RECHECK-CI acme\/web#1/m);
  assert.match(text, /2 listed, 1 not reached, 0 outside the allowlist, truncated: yes$/);
});

test('queue refuses a bad invocation or an empty allowlist with exit 2, before any request', async () => {
  const impl = fakeGitHub();
  await withDb(async (db) => {
    for (const argv of [['--source', 'everything'], ['--source'], ['--max', '0'], ['--max', 'x'], ['--source', 'team']]) {
      const { deps } = commandDeps(impl, keepOpen(db));
      assert.equal(await queueCommand(argv, deps), 2, argv.join(' '));
    }
    const empty = commandDeps(impl, keepOpen(db), { allowlist: [] });
    assert.equal(await queueCommand([], empty.deps), 2);
    assert.match(empty.err.join('\n'), /No repositories are allowlisted/);
    const none = commandDeps(impl, keepOpen(db));
    none.deps.config = null;
    assert.equal(await queueCommand([], none.deps), 2);
  });
  assert.equal(impl.calls.length, 0);
});

test('the built CLI has queue help and refuses bad invocations with exit 2', () => {
  const data = mkdtempSync(join(tmpdir(), 'rv-queue-cli-'));
  const cwd = mkdtempSync(join(tmpdir(), 'rv-queue-cwd-'));
  try {
    const run = (args) =>
      spawnSync(process.execPath, [bundle, ...args], { encoding: 'utf8', cwd, env: { ...process.env, REVIEW_VOICE_DATA_DIR: data } });
    const help = run(['queue', '--help']);
    assert.equal(help.status, 0);
    for (const name of ['--source', '--max', '--json', 'Exit codes:']) assert.ok(help.stdout.includes(name), name);
    assert.equal(run(['queue', '--source', 'bogus']).status, 2);
    // Outside a configured repository there is no allowlist, so nothing is read.
    const bare = run(['queue']);
    assert.equal(bare.status, 2);
    assert.match(bare.stderr, /No repositories are allowlisted/);
  } finally {
    rmSync(data, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

// --- owner globs in the commands that read repositories by name ---

/** A git repository with `include` as its allowlist, and the bundle run inside it with no GitHub credential. */
function inConfiguredRepo(include, body) {
  const cwd = mkdtempSync(join(tmpdir(), 'rv-queue-glob-'));
  const data = mkdtempSync(join(tmpdir(), 'rv-queue-glob-data-'));
  const bin = mkdtempSync(join(tmpdir(), 'rv-queue-glob-bin-'));
  try {
    spawnSync('git', ['init', '-q'], { cwd });
    mkdirSync(join(cwd, '.review-voice'));
    writeFileSync(
      join(cwd, '.review-voice', 'config.yaml'),
      `identity:\n  owner_reviewer: ${ME}\nrepositories:\n  include: [${include.join(', ')}]\n`,
    );
    // A `gh` that has no token, so a sync stops at the credential before any request.
    writeFileSync(join(bin, 'gh'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    const env = { ...process.env, REVIEW_VOICE_DATA_DIR: data, PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin` };
    delete env.GITHUB_TOKEN;
    delete env.GH_TOKEN;
    const run = (args) => spawnSync(process.execPath, [bundle, ...args], { encoding: 'utf8', cwd, env });
    body(run);
  } finally {
    for (const dir of [cwd, data, bin]) rmSync(dir, { recursive: true, force: true });
  }
}

test('sync reads the repositories listed by name and skips an owner glob with a note', () => {
  inConfiguredRepo(['acme/web', 'acme-labs/*'], (run) => {
    const result = run(['sync', '--dry-run']);
    assert.match(result.stderr, /^acme-labs\/\* is a pattern; sync reads only repositories listed by name\.$/m);
    assert.match(result.stderr, /\[1\/1\] reading acme\/web/);
    assert.doesNotMatch(result.stderr, /not in the allowlist/);
    // It stops at the missing credential, not at the glob.
    assert.match(result.stderr, /No GitHub credential/);
  });
});

test('sync with only owner globs exits 2 with the note, not "not in the allowlist"', () => {
  inConfiguredRepo(['acme/*', 'acme-labs/*'], (run) => {
    const result = run(['sync']);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /acme\/\* is a pattern; sync reads only repositories listed by name\./);
    assert.match(result.stderr, /acme-labs\/\* is a pattern/);
    assert.doesNotMatch(result.stderr, /not in the allowlist|reading/);
  });
});

test('consent-plan plans for the repositories listed by name and skips an owner glob with a note', () => {
  inConfiguredRepo(['acme/web', 'acme-labs/*'], (run) => {
    const result = run(['consent-plan']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /acme-labs\/\* is a pattern; consent-plan reads only repositories listed by name\./);
    assert.ok(result.stdout.includes('acme/web'));
    assert.ok(!result.stdout.includes('acme-labs'));
  });
  inConfiguredRepo(['acme-labs/*'], (run) => {
    const result = run(['consent-plan']);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /acme-labs\/\* is a pattern/);
  });
});

test('status does not report an owner glob as a repository with no events', () => {
  inConfiguredRepo(['acme/web', 'acme-labs/*'], (run) => {
    const result = run(['status']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /acme-labs\/\* is a pattern; status reads only repositories listed by name\./);
    assert.ok(!result.stdout.includes('acme-labs'));
  });
});
