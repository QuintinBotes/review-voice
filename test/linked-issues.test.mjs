/**
 * S19: ticket intent from linked GitHub issues. With `review.linked_issues`
 * on, `thread` reads the same-repository issues the description closes, the
 * intent extractor may quote a whole sentence of an issue body, and
 * `check-intent` verifies each quote against the one source it came from.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { closingReferences, readThread } from '../plugins/review-voice/src/diff/thread.ts';
import { GitHubClient } from '../plugins/review-voice/src/github/client.ts';
import { loadConfig } from '../plugins/review-voice/src/policy/load.ts';
import { parseIntent } from '../plugins/review-voice/src/intent.ts';
import { intentPrompt } from '../plugins/review-voice/src/review/prompts.ts';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const plugin = join(root, 'plugins/review-voice');
const bundle = join(plugin, 'dist/review-voice.mjs');
const REPO = 'acme/web';
// An inherited override would make loadConfig read another file than the temp repo's.
delete process.env.REVIEW_VOICE_CONFIG;

const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

function withDir(prefix, fn) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('S19 AC-1: closingReferences finds every closing keyword and form, in order, capped and deduplicated, and skips other repositories', () => {
  const description = [
    'Closes #1 and closed: #2, then close #3.',
    'Fix acme/web#4; fixes #5; FIXED #6.',
    'Resolve https://github.com/Acme/Web/issues/7, resolves #8, resolved: #9.',
    'Closes #1 again, closes #6 again. Closes other/repo#10 and fixes https://github.com/other/repo/issues/11.',
    'See #12 for background. Fixes nothing here.',
  ].join('\n');
  assert.deepEqual(closingReferences(description, REPO), {
    numbers: [1, 2, 3, 4, 5],
    beyond: [6, 7, 8, 9],
    skipped: ['other/repo#10', 'https://github.com/other/repo/issues/11'],
  });
  assert.deepEqual(closingReferences('See #12 for background. Fixes nothing here. #13', REPO), { numbers: [], beyond: [], skipped: [] });
  assert.deepEqual(closingReferences('', REPO), { numbers: [], beyond: [], skipped: [] });
});

const TOKEN = ['gh', 'p_', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'].join('');

function threadServer(description, issues) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const path = new URL(String(url)).pathname;
    calls.push({ path, method: init?.method ?? 'GET' });
    if (path === `/repos/${REPO}/pulls/7`) return json({ body: description, user: { login: 'acme-author' } });
    const issue = new RegExp(`^/repos/${REPO}/issues/(\\d+)$`).exec(path);
    // GitHub names the issue and its repository in every answer; a fixture overrides them to play a transferred issue.
    if (issue !== null) {
      return issue[1] in issues ? json({ number: Number(issue[1]), repository_url: `https://api.github.com/repos/${REPO}`, ...issues[issue[1]] }) : json({ message: 'Not Found' }, 404);
    }
    return json([]);
  };
  return { calls, client: new GitHubClient({ allowlist: [REPO], token: 'test-token', fetchImpl }) };
}

test('S19 AC-2: with the option off no issue is requested and the thread has no linkedIssues key', async () => {
  const { calls, client } = threadServer('Closes #12', {});
  const thread = await readThread({ repository: REPO, pullNumber: 7, client });
  assert.equal(calls.some((call) => call.path.includes('/issues/12')), false);
  assert.equal('linkedIssues' in thread, false);
  assert.equal(thread.warnings, undefined);
});

test('S19 AC-2: with the option on each closed issue is read once as GET, redacted, capped, and the rest is named in warnings', async () => {
  const description = 'Closes #12, fixes #13, resolves #14 and closes #15.\nAlso fixes other/repo#3. Closes #16, closes #17 and fixes #18.';
  // A token sits in the kept part, and the cap lands mid-paragraph, so the body is redacted and then cut back to its last blank line.
  const long = `${'x'.repeat(9000)}\n\nUse ${TOKEN} here.\n\n${'y'.repeat(985)} ${TOKEN} end`;
  const { calls, client } = threadServer(description, {
    12: { title: `Token ${TOKEN} in title`, body: `Use the key ${TOKEN} to sign in.`, state: 'open', html_url: `https://github.com/${REPO}/issues/12` },
    13: { title: 'A pull request', body: 'Not an issue.', state: 'open', pull_request: { url: 'x' } },
    15: { title: 'Long', body: long, state: 'closed', html_url: `https://github.com/${REPO}/issues/15` },
    16: { title: 'No body', body: null, state: 'open', html_url: `https://github.com/${REPO}/issues/16` },
  });
  const thread = await readThread({ repository: REPO, pullNumber: 7, client, linkedIssues: true });
  const issueCalls = calls.filter((call) => /\/issues\/\d+$/.test(call.path));
  assert.deepEqual(issueCalls, [12, 13, 14, 15, 16].map((n) => ({ path: `/repos/${REPO}/issues/${n}`, method: 'GET' })));
  assert.equal(calls.some((call) => call.path.includes('other/repo')), false);
  assert.deepEqual(thread.linkedIssues.map((issue) => issue.number), [12, 15, 16]);
  const [first, long15, empty] = thread.linkedIssues;
  assert.equal(first.body.includes(TOKEN), false);
  assert.match(first.body, /\[REDACTED:/);
  assert.match(first.title, /\[REDACTED:/);
  assert.equal(first.truncated, undefined);
  assert.ok(long15.body.length <= 10000);
  assert.ok(long15.body.endsWith(' here.'), 'cut back to the last blank line before the cap');
  assert.equal(long15.truncated, true);
  assert.equal(long15.body.includes(TOKEN.slice(0, 8)), false);
  assert.match(long15.body, /\[REDACTED:/);
  assert.deepEqual(empty, { number: 16, title: 'No body', body: '', state: 'open', url: `https://github.com/${REPO}/issues/16` });
  assert.deepEqual(thread.warnings, [
    `Skipped other/repo#3: a linked issue outside ${REPO} is not read.`,
    'Read the first 5 linked issues; not read: #17, #18.',
    `Could not read issue #14 (GitHub returned 404 for /repos/${REPO}/issues/14: {"message":"Not Found"}); continuing without it.`,
  ]);
  // The thread file is what the extractor reads, so the key sits where the spec puts it.
  assert.deepEqual(Object.keys(thread), ['repository', 'pullNumber', 'comments', 'reviews', 'linkedIssues', 'truncated', 'warnings']);
});

test('S19 AC-2: an answer for another repository or number, as after a transfer, is not stored as the issue asked for', async () => {
  const { client } = threadServer('Closes #12 and fixes #13', {
    12: { repository_url: 'https://api.github.com/repos/other/private', title: 'Moved', body: 'A private plan.', state: 'open', html_url: 'https://github.com/other/private/issues/12' },
    13: { number: 31, title: 'Renumbered', body: 'Another issue.', state: 'open', html_url: `https://github.com/${REPO}/issues/31` },
  });
  const thread = await readThread({ repository: REPO, pullNumber: 7, client, linkedIssues: true });
  assert.deepEqual(thread.linkedIssues, []);
  assert.deepEqual(
    thread.warnings,
    [12, 13].map((n) => `Could not read issue #${n} (GitHub answered for another issue or repository); continuing without it.`),
  );
});

test('S19 AC-3: review.linked_issues is read into linkedIssues, a non-boolean warns and keeps false', () => {
  const load = (config) =>
    withDir('rv-linked-config-', (dir) => {
      mkdirSync(join(dir, '.review-voice'));
      writeFileSync(join(dir, '.review-voice', 'config.yaml'), config);
      return loadConfig(dir);
    });
  assert.equal(load('review:\n  mode: auto\n').linkedIssues, false);
  const on = load('review:\n  linked_issues: true\n');
  assert.equal(on.linkedIssues, true);
  assert.deepEqual(on.warnings, []);
  const bad = load('review:\n  linked_issues: yes\n');
  assert.equal(bad.linkedIssues, false);
  assert.deepEqual(bad.warnings, ['review.linked_issues must be true or false; using false.']);
});

// 'Shipping costs are not part of the total.' is in both sources, as a pasted requirement would be.
const DESCRIPTION =
  'Multiply each price by its quantity so the total is right. Shipping costs are not part of the total. Rounding stays as it is because invoices are compared by hand.\n\nCloses #5';
const ISSUE_BODY =
  '## Problem\nThe total ignores quantity.\n\nThe total must multiply each price by its quantity. Discounts are out of scope for this issue. Shipping costs are not part of the total.\n\n## Scope\nTotals only. Nothing else on the invoice changes.';

function checkIntent(statements) {
  return withDir('rv-linked-intent-', (dir) => {
    const thread = join(dir, 'thread.json');
    writeFileSync(
      thread,
      JSON.stringify({
        repository: REPO,
        pullNumber: 7,
        comments: [{ path: null, line: null, author: 'author', body: DESCRIPTION, kind: 'description' }],
        reviews: [],
        linkedIssues: [{ number: 5, title: 'Totals ignore quantity', body: ISSUE_BODY, state: 'open', url: `https://github.com/${REPO}/issues/5` }],
      }),
    );
    return spawnSync(process.execPath, [bundle, 'check-intent', '--thread', thread], { encoding: 'utf8', input: JSON.stringify({ statements }) });
  });
}

const fromIssue = { id: 'int_001', kind: 'goal', statement: 'The total multiplies price by quantity.', quote: 'The total must multiply each price by its quantity.' };
const fromDescription = { id: 'int_002', kind: 'goal', statement: 'Each price is multiplied by its quantity.', quote: 'Multiply each price by its quantity so the total is right.' };
const inBoth = { id: 'int_005', kind: 'non-goal', statement: 'Shipping costs stay out of the total.', quote: 'Shipping costs are not part of the total.' };

test('S19 AC-4: check-intent records the issue a quote came from, recomputes a supplied one and re-checks its own output', () => {
  const result = checkIntent([fromIssue, fromDescription, { ...fromDescription, id: 'int_003', issue: 5 }, { ...fromIssue, id: 'int_004', issue: 99 }, inBoth]);
  assert.equal(result.status, 0, result.stderr);
  const out = JSON.parse(result.stdout);
  // A sentence in both sources is the author's own, so the description wins.
  assert.deepEqual(out.statements.map((s) => s.issue), [5, undefined, undefined, 5, undefined]);
  const again = checkIntent(out.statements);
  assert.equal(again.status, 0, again.stderr);
  assert.deepEqual(JSON.parse(again.stdout), out);
});

test('S19 AC-4: a fragment of an issue sentence is widened to that sentence, from that issue', () => {
  const result = checkIntent([{ ...fromIssue, quote: 'multiply each price by its quantity' }]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).statements[0], { ...fromIssue, issue: 5 });
  assert.match(result.stderr, /Widened quote of int_001 to its whole sentence/);
});

test('S19 AC-4: a short issue sentence keeps the heading of its own section and its note names the issue', () => {
  const result = checkIntent([{ id: 'int_001', kind: 'non-goal', statement: 'Only totals change.', quote: 'Totals only.' }]);
  assert.equal(result.status, 0, result.stderr);
  const [kept] = JSON.parse(result.stdout).statements;
  assert.equal(kept.heading, 'Scope');
  assert.equal(kept.issue, 5);
  assert.match(result.stderr, /Kept quote of int_001 under 4 words: it is a whole sentence of issue #5/);
});

test('S19 AC-4: a quote in no source names the linked issues even when every issue given has an empty body', () => {
  const { dropped } = parseIntent({ statements: [fromIssue] }, DESCRIPTION, [{ number: 5, body: '' }]);
  assert.deepEqual(dropped, ['int_001 (statements[0].quote does not occur in the pull request description or in a linked issue)']);
});

for (const [name, statements, problem] of [
  ['a quote in neither source', [{ ...fromIssue, quote: 'The total must multiply each price by its weight.' }], /quote does not occur in the pull request description or in a linked issue/],
  ['a quote across two issue sentences, as a fragment rather than as not found', [{ ...fromIssue, quote: 'quantity. Discounts are out of scope' }], /quote must be a whole sentence or list item of the description, not part of one/],
  [
    'a deliberate reason from the other source',
    [{ id: 'int_001', kind: 'deliberate', statement: 'Discounts stay out.', quote: 'Discounts are out of scope for this issue.', reason: 'Rounding stays as it is because invoices are compared by hand.' }],
    /reason must be in the same source as its quote/,
  ],
]) {
  test(`S19 AC-4: check-intent refuses ${name}`, () => {
    const result = checkIntent(statements);
    assert.equal(result.status, 2);
    assert.match(result.stderr, problem);
  });
}

test('S19 AC-6: the agent prompts name the linked issues and the challenge prompt labels a quote from one', () => {
  const agent = (name) => readFileSync(join(plugin, 'agents', `${name}.md`), 'utf8');
  for (const name of ['intent-extractor', 'diff-analyst', 'evidence-verifier']) assert.match(agent(name), /linkedIssues/, name);
  assert.match(agent('challenger'), /linked issue/);
  assert.match(intentPrompt({ dir: '/run', intent: false, followUps: false }, 'Title', [5, 9]), /closes #5, #9/);
  assert.doesNotMatch(intentPrompt({ dir: '/run', intent: false, followUps: false }, 'Title'), /linkedIssues/);

  withDir('rv-linked-challenge-', (dir) => {
    const write = (name, value) => {
      const path = join(dir, name);
      writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value));
      return path;
    };
    const finding = { candidateId: 'cand_001', candidate_id: 'cand_001', path: 'src/a.ts', line: 3, claim: 'The total ignores quantity.', failureMode: 'Wrong totals.', category: 'correctness' };
    const scores = write('scores.json', { scores: [{ ...finding, eligible: true }], eligible: [finding], distribution: { count: 1 }, belowGate: [] });
    const candidates = write('checked.json', { candidates: [{ ...finding, intent_ref: 'int_001' }] });
    const intent = write('intent.json', { statements: [{ ...fromIssue, issue: 5 }, fromDescription] });
    const run = spawnSync(process.execPath, [bundle, 'challenge', '--scores', scores, '--candidates', candidates, '--intent', intent, '--emit-prompts'], {
      encoding: 'utf8',
      env: { ...process.env, REVIEW_VOICE_DATA_DIR: dir },
    });
    assert.equal(run.status, 0, run.stderr);
    const [{ prompt }] = JSON.parse(run.stdout).prompts;
    assert.match(prompt, /quoted from linked issue #5 \(untrusted\):\n- int_001 \(goal\): "The total must multiply each price by its quantity\."/);
    assert.doesNotMatch(prompt, /pull request description/);
  });
});

test('S19: a transferred issue is not followed to its new repository, and is skipped with a warning', async () => {
  const calls = [];
  // A fetch that behaves as Node's does: it follows a redirect unless asked not to.
  const fetchImpl = async (url, init) => {
    const path = new URL(String(url)).pathname;
    calls.push(path);
    if (path === `/repos/${REPO}/pulls/7`) return json({ body: 'Closes #12.', user: { login: 'acme-author' } });
    if (path === `/repos/${REPO}/issues/12`) {
      if (init?.redirect === 'manual') return new Response('', { status: 301, headers: { location: 'https://api.github.com/repositories/99/issues/12' } });
      calls.push('/repositories/99/issues/12');
      return json({ number: 12, repository_url: 'https://api.github.com/repos/other/place', title: 'Moved', body: 'Moved away.' });
    }
    return json([]);
  };
  const client = new GitHubClient({ allowlist: [REPO], token: 'test-token', fetchImpl });
  const thread = await readThread({ repository: REPO, pullNumber: 7, client, linkedIssues: true });
  assert.ok(!calls.includes('/repositories/99/issues/12'), `the redirect was followed: ${calls.join(', ')}`);
  assert.deepEqual(thread.linkedIssues ?? [], []);
  assert.ok((thread.warnings ?? []).some((warning) => /^Could not read issue #12 \(/.test(warning)), (thread.warnings ?? []).join('\n'));
});

test('S19: a sentence the issue-body cap would split is dropped whole, so its first half is never quotable', async () => {
  const condition = 'Allow all anonymous downloads only after the owner makes the file public.';
  const { client } = threadServer('Closes #12.', { 12: { title: 'Downloads', body: `${'x'.repeat(9969)}\n\n${condition}` } });
  const thread = await readThread({ repository: REPO, pullNumber: 7, client, linkedIssues: true });
  const [issue] = thread.linkedIssues;
  assert.equal(issue.truncated, true);
  assert.ok(!issue.body.includes('Allow all anonymous downloads'), 'the clipped half of the sentence survived the cap');
  assert.ok(issue.body.length <= 10000);
});
