// #548: a changed contract is looked up in the other allowlisted repositories
// through GitHub code search, read-only and inside the allowlist, under a
// small request budget, and a failed search degrades to a note.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitHubClient, NotAllowlisted } from '../plugins/review-voice/src/github/client.ts';
import { contractNames, linkedConsumers } from '../plugins/review-voice/src/diff/linked.ts';
import { loadConfig } from '../plugins/review-voice/src/policy/load.ts';

// One exported function retyped, one removed, one unrelated line.
const diff = [
  'diff --git a/src/orders.ts b/src/orders.ts',
  '--- a/src/orders.ts',
  '+++ b/src/orders.ts',
  '@@ -1,6 +1,4 @@',
  '-export function parseOrderTotal(order: Order): number {',
  '+export function parseOrderTotal(order: Order, currency: string): Money {',
  '   return order.lines.reduce((sum, line) => sum + line.amount, 0);',
  ' }',
  '-export function formatOrderLabel(order: Order): string {',
  '-  return order.id;',
  ' }',
  '',
].join('\n');

/** The real shape of `GET /search/code` with the text-match media type. */
function codeSearchItem(fullName, path, fragment, term) {
  const [owner, name] = fullName.split('/');
  return {
    name: path.split('/').pop(),
    path,
    sha: 'd670460b4b4aece5915caf5c68d12f560a9fe3e4',
    url: `https://api.github.com/repositories/1296269/contents/${path}?ref=d670460b4b4aece5915caf5c68d12f560a9fe3e4`,
    git_url: 'https://api.github.com/repositories/1296269/git/blobs/d670460b4b4aece5915caf5c68d12f560a9fe3e4',
    html_url: `https://github.com/${fullName}/blob/d670460b4b4aece5915caf5c68d12f560a9fe3e4/${path}`,
    repository: {
      id: 1296269,
      node_id: 'MDEwOlJlcG9zaXRvcnkxMjk2MjY5',
      name,
      full_name: fullName,
      private: true,
      owner: { login: owner, id: 1, type: 'Organization' },
      html_url: `https://github.com/${fullName}`,
      url: `https://api.github.com/repos/${fullName}`,
    },
    score: 1,
    text_matches: [
      {
        object_url: `https://api.github.com/repositories/1296269/contents/${path}?ref=d670460b4b4aece5915caf5c68d12f560a9fe3e4`,
        object_type: 'FileContent',
        property: 'content',
        fragment,
        matches: [{ text: term, indices: [fragment.indexOf(term), fragment.indexOf(term) + term.length] }],
      },
    ],
  };
}

function fakeGitHub(answer) {
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url: String(url), init });
    return answer(new URL(String(url)), init);
  };
  return { requests, fetchImpl };
}

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const client = (fetchImpl) =>
  new GitHubClient({ allowlist: ['acme/shop', 'acme/*'], allowGlobs: true, token: 'test-token', fetchImpl });

test('a consumer in another allowlisted repository is reported, redacted, from code search only', async () => {
  const secret = 'ghp_' + 'a'.repeat(36);
  const use = `const total = parseOrderTotal(order); // token ${secret}`;
  const github = fakeGitHub((url) => {
    if (url.pathname.startsWith('/repos/acme/billing/git/blobs/')) return new Response('// billing\n' + use);
    const q = url.searchParams.get('q');
    if (q === '"parseOrderTotal" repo:acme/billing') {
      return json({
        total_count: 2,
        incomplete_results: false,
        items: [
          codeSearchItem('acme/billing', 'src/invoice.ts', use, 'parseOrderTotal'),
          // A result from any other repository is dropped, unread.
          codeSearchItem('stranger/fork', 'src/copy.ts', 'parseOrderTotal(order)', 'parseOrderTotal'),
        ],
      });
    }
    return json({ total_count: 0, incomplete_results: false, items: [] });
  });

  const result = await linkedConsumers({ diff, linked: ['acme/billing'], client: client(github.fetchImpl), remaining: () => 60_000 });

  assert.deepEqual(result.symbols, ['parseOrderTotal', 'formatOrderLabel']);
  assert.deepEqual(result.searched, ['acme/billing']);
  assert.equal(result.inconclusive, undefined);
  assert.equal(result.consumers.length, 1);
  const [consumer] = result.consumers;
  assert.equal(consumer.symbol, 'parseOrderTotal');
  assert.equal(consumer.repository, 'acme/billing');
  assert.equal(consumer.path, 'src/invoice.ts');
  assert.match(consumer.fragments[0], /parseOrderTotal\(order\)/);
  assert.ok(!consumer.fragments[0].includes(secret));
  assert.equal(consumer.line, 2);

  assert.equal(github.requests.length, 3);
  for (const { url, init } of github.requests) {
    if (new URL(url).pathname.includes('/git/blobs/')) continue;
    assert.equal(init.method, 'GET');
    assert.equal(init.headers.accept, 'application/vnd.github.text-match+json');
  }
});

test('a linked repository outside the allowlist is never queried, and the note says so', async () => {
  const github = fakeGitHub(() => json({ total_count: 0, incomplete_results: false, items: [] }));

  const result = await linkedConsumers({
    diff,
    linked: ['other/secret', 'acme/billing'],
    client: client(github.fetchImpl),
    remaining: () => 60_000,
  });

  assert.deepEqual(result.skipped, ['other/secret']);
  assert.deepEqual(result.searched, ['acme/billing']);
  assert.equal(github.requests.length, 2);
  assert.ok(github.requests.every(({ url }) => !decodeURIComponent(url).includes('other/secret')));
  assert.match(result.note, /other\/secret is linked but not in repositories\.include/);

  // The client refuses it itself, and a term that is not an identifier, whoever asks.
  await assert.rejects(client(github.fetchImpl).searchCode('parseOrderTotal', 'other/secret'), NotAllowlisted);
  await assert.rejects(client(github.fetchImpl).searchCode('x" repo:other/secret', 'acme/billing'), NotAllowlisted);
  assert.equal(github.requests.length, 2);
});

test('the request budget caps the searches and leaves the result inconclusive', async () => {
  const github = fakeGitHub(() => json({ total_count: 0, incomplete_results: false, items: [] }));

  const result = await linkedConsumers({
    diff,
    linked: ['acme/billing', 'acme/ledger'],
    client: client(github.fetchImpl),
    maxRequests: 3,
    remaining: () => 60_000,
  });

  // Two names in two repositories would be four searches.
  assert.equal(github.requests.length, 3);
  assert.equal(result.inconclusive, true);
  assert.equal(result.reason, 'request-budget');
  assert.match(result.note, /budget of 3 GitHub requests ran out/);

  const timed = await linkedConsumers({ diff, linked: ['acme/billing'], client: client(github.fetchImpl), remaining: () => 0 });
  assert.equal(github.requests.length, 3);
  assert.equal(timed.reason, 'time-budget');
});

test('a failed search degrades to a note and never throws', async () => {
  const github = fakeGitHub(() =>
    json({ message: 'Resource not accessible by integration', documentation_url: 'https://docs.github.com/rest/search/search#search-code', status: '403' }, 403),
  );

  const result = await linkedConsumers({ diff, linked: ['acme/billing', 'acme/ledger'], client: client(github.fetchImpl), remaining: () => 60_000 });

  // No rate-limit retry, and no further search once one failed.
  assert.equal(github.requests.length, 1);
  assert.deepEqual(result.consumers, []);
  assert.equal(result.inconclusive, true);
  assert.equal(result.reason, 'search-failed');
  assert.match(result.note, /GitHub returned 403/);
});

test('review.linked_repositories is read, and an owner glob is refused', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rv-issue-548-'));
  try {
    const path = join(dir, 'config.yaml');
    writeFileSync(path, 'repositories:\n  include: [acme/*]\nreview:\n  linked_repositories: [acme/billing, acme/*]\n');
    const config = loadConfig(dir, join(dir, 'no-baseline.yaml'), path);
    assert.deepEqual(config.linkedRepositories, ['acme/billing']);
    assert.ok(config.warnings.some((warning) => warning.includes('review.linked_repositories: "acme/*"')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('removed schema keys and literal routes are searched', () => {
  assert.deepEqual(contractNames('-  "billing_address": field,\n-router.get("/orders/totals", handler)'), ['billing_address', '/orders/totals']);
});

test('a pending GitHub request is aborted at the time budget', async () => {
  const github = fakeGitHub((_url, init) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(json({ items: [] })), 1000);
    init.signal.addEventListener('abort', () => { clearTimeout(timer); reject(init.signal.reason); }, { once: true });
  }));
  const result = await linkedConsumers({ diff, linked: ['acme/billing'], client: client(github.fetchImpl), remaining: () => 10 });
  assert.equal(result.reason, 'time-budget');
  assert.equal(github.requests.length, 1);
});

test('linked search and the matching blob both use the configured enterprise API root', async () => {
  const api = 'https://enterprise.example/api/v3';
  const symbol = 'parseOrderTotal';
  const use = 'const total = parseOrderTotal(order);';
  const item = codeSearchItem('acme/billing', 'src/invoice.ts', use, symbol);
  const github = fakeGitHub((url, init) => {
    assert.equal(url.origin, 'https://enterprise.example');
    if (url.pathname === '/api/v3/search/code') {
      assert.equal(init.redirect, 'manual');
      return json({ total_count: 1, items: [item] });
    }
    assert.equal(url.pathname, '/api/v3/repos/acme/billing/git/blobs/' + item.sha);
    assert.equal(init.redirect, 'error');
    return new Response('// consumer\n' + use);
  });
  const client = new GitHubClient({ baseUrl: api, allowlist: ['acme/billing'], token: 't', fetchImpl: github.fetchImpl });
  const abort = new AbortController();
  const found = await client.searchCode(symbol, 'acme/billing', abort.signal);
  assert.equal(found.matches.length, 1);
  assert.equal(await client.readSearchBlob(found.matches[0].repository, found.matches[0].blob, abort.signal), '// consumer\n' + use);
  assert.equal(github.requests.length, 2);
});
