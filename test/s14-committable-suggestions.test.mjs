/**
 * Committable suggestion blocks for verified fixes (docs/adr/0033): the patch
 * a candidate carries is checked against the diff, kept through score and
 * record, posted only behind a verified fix and a matching head, withheld
 * visibly otherwise, and recognised by `outcomes` once applied. GitHub is
 * stubbed; nothing here writes anywhere but a temporary store.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normaliseCandidate } from '../plugins/review-voice/src/scoring/score.ts';
import { openDatabase } from '../plugins/review-voice/src/store/db.ts';
import { recordRun } from '../plugins/review-voice/src/store/runs.ts';
import { recordAudit } from '../plugins/review-voice/src/store/audit.ts';
import { checkOutcomes } from '../plugins/review-voice/src/store/outcomes.ts';
import { GitHubClient } from '../plugins/review-voice/src/github/client.ts';
import { ReviewWriter, WriteViolation } from '../plugins/review-voice/src/github/writer.ts';
import { loadConfig } from '../plugins/review-voice/src/policy/load.ts';
import { computeVerdict, postReview } from '../plugins/review-voice/src/publish/post.ts';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const plugin = join(root, 'plugins/review-voice');
const bundle = join(plugin, 'dist/review-voice.mjs');
const read = (path) => readFileSync(join(root, path), 'utf8');

const HEAD = 'a'.repeat(40);
const NEW_HEAD = 'b'.repeat(40);
const REPO = 'acme/web';
const PR = 7;
const FILE = 'src/auth.ts';

const ORIGINAL = 'res.json(token);\nawait tx.commit();';
const REPLACEMENT = 'await tx.commit();\nres.json(token);';
const PATCH = { start_line: 84, end_line: 85, original: ORIGINAL, replacement: REPLACEMENT };
const PROSE = 'The token is returned before commit. A retry mints two.';
const BLOCKING = `[blocking] \`${FILE}:85\` - ${PROSE}`;
const BLOCK = `\`\`\`suggestion\n${REPLACEMENT}\n\`\`\``;

/** The file at a head: filler lines with `at84` from line 84 on. */
const fileWith = (at84) => [...Array.from({ length: 83 }, (_, i) => `// line ${i + 1}`), ...at84.split('\n'), 'return;', ''].join('\n');
const HEAD_FILE = fileWith(ORIGINAL);
const APPLIED_FILE = fileWith(REPLACEMENT);

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
/** As GitHub sends it: base64 wrapped at 60 characters. */
const contents = (text) => json({ type: 'file', encoding: 'base64', content: Buffer.from(text, 'utf8').toString('base64').replace(/(.{60})/g, '$1\n') });

const client = (impl) => new GitHubClient({ allowlist: [REPO], token: 't', fetchImpl: impl, sleep: async () => {} });

function cli(args, input, dataDir) {
  try {
    const stdout = execFileSync(process.execPath, [bundle, ...args], { encoding: 'utf8', input, env: { ...process.env, REVIEW_VOICE_DATA_DIR: dataDir } });
    return { code: 0, stdout, stderr: '' };
  } catch (error) {
    return { code: error.status, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

function withDir(body) {
  const dir = mkdtempSync(join(tmpdir(), 'rv-s14-'));
  return Promise.resolve()
    .then(() => body(dir))
    .finally(() => rmSync(dir, { recursive: true, force: true }));
}

async function withDb(body) {
  await withDir(async (dir) => {
    const previous = process.env.REVIEW_VOICE_DATA_DIR;
    process.env.REVIEW_VOICE_DATA_DIR = dir;
    const db = openDatabase(join(dir, 'review-voice.db'));
    try {
      await body(db);
    } finally {
      db.close();
      if (previous === undefined) delete process.env.REVIEW_VOICE_DATA_DIR;
      else process.env.REVIEW_VOICE_DATA_DIR = previous;
    }
  });
}

// ---------------------------------------------------------------------------
// AC-1: the candidate field, check-candidates against the diff, and score.
// ---------------------------------------------------------------------------

const candidate = (patch = PATCH, over = {}) => ({
  candidate_id: 'cand_001',
  path: FILE,
  line: 85,
  category: 'correctness',
  severity: 'blocking',
  claim: 'The response returns the token before its transaction commits.',
  failure_mode: 'A retried request mints two valid tokens.',
  evidence: ['The response is sent at line 84.', 'The commit runs at line 85.'],
  suggested_fix: 'Commit the transaction before sending the response.',
  technical_confidence: 0.9,
  suggested_patch: patch,
  ...over,
});

/** Two added lines, 84 and 85, between context lines 82, 83 and 86. */
const DIFF = [
  `diff --git a/${FILE} b/${FILE}`,
  `--- a/${FILE}`,
  `+++ b/${FILE}`,
  '@@ -82,3 +82,5 @@',
  ' const token = mint();',
  ' const tx = begin();',
  '+res.json(token);',
  '+await tx.commit();',
  ' return;',
  '',
].join('\n');

test('normaliseCandidate carries a valid patch and names the rule a malformed one breaks', () => {
  assert.deepEqual(normaliseCandidate(candidate(), 0).suggestedPatch, PATCH);
  assert.deepEqual(normaliseCandidate(candidate({ ...PATCH, start_line: 85, original: 'await tx.commit();' }), 0).suggestedPatch.start_line, 85);
  const { suggested_patch: _patch, ...plain } = candidate();
  assert.equal('suggestedPatch' in normaliseCandidate(plain, 0), false, 'an ordinary candidate keeps its shape');
  const refused = [
    [null, /must be an object/],
    [{ ...PATCH, start_line: 86 }, /1 <= start_line <= end_line/],
    [{ ...PATCH, start_line: 1.5 }, /whole numbers/],
    [{ ...PATCH, start_line: 80 }, /more than 5 lines/],
    [{ ...PATCH, end_line: 84, start_line: 84 }, /end_line must be the candidate/],
    [{ start_line: 84, end_line: 85, replacement: REPLACEMENT }, /original must be a string/],
    [{ ...PATCH, replacement: 'x'.repeat(601) }, /replacement is longer than 600/],
    [{ ...PATCH, original: 'y'.repeat(601) }, /original is longer than 600/],
    [{ ...PATCH, replacement: 'await tx.commit();\n```' }, /three backticks/],
    [{ ...PATCH, replacement: '   ```js\nres.json(token);' }, /three backticks/],
  ];
  for (const [patch, rule] of refused) {
    assert.throws(() => normaliseCandidate(candidate(patch), 0), rule, JSON.stringify(patch));
  }
});

test('check-candidates accepts a patch on added lines ending at the anchor with a matching original', () =>
  withDir((dir) => {
    const diff = join(dir, 'diff.patch');
    writeFileSync(diff, DIFF);
    const run = (patch) => cli(['check-candidates', '--diff-file', diff], JSON.stringify({ candidates: [candidate(patch)] }), dir);

    const ok = run(PATCH);
    assert.equal(ok.code, 0, ok.stderr);
    assert.equal(JSON.parse(ok.stdout).valid, true);
    assert.equal(run({ ...PATCH, start_line: 85, original: 'await tx.commit();', replacement: '' }).code, 0, 'a one-line deletion');

    // Range and text checks fail like an anchor, so the driver routes them back.
    for (const [patch, why] of [
      [{ ...PATCH, start_line: 83, original: `const tx = begin();\n${ORIGINAL}` }, /83, which is not an added line/],
      [{ ...PATCH, original: 'res.json(tok);\nawait tx.commit();' }, /copy those lines exactly/],
    ]) {
      const refused = run(patch);
      assert.equal(refused.code, 1, refused.stderr);
      const [failure] = JSON.parse(refused.stdout).anchorFailures;
      assert.equal(failure.candidateId, 'cand_001');
      assert.equal(failure.kind, 'suggested-patch');
      assert.match(failure.reason, why);
    }

    // Shape rules refuse the candidate before the diff is read.
    for (const [patch, why] of [
      [{ ...PATCH, start_line: 80, original: 'x' }, /more than 5 lines/],
      [{ ...PATCH, start_line: 84, end_line: 84, original: 'res.json(token);' }, /end_line must be the candidate/],
      [{ start_line: 84, end_line: 85, replacement: REPLACEMENT }, /original must be a string/],
      [{ ...PATCH, replacement: 'z'.repeat(601) }, /longer than 600/],
      [{ ...PATCH, replacement: '```\nres.json(token);' }, /three backticks/],
    ]) {
      const refused = run(patch);
      assert.equal(refused.code, 2, `${JSON.stringify(patch)}: ${refused.stdout}`);
      assert.match(refused.stderr, why);
    }
  }));

test('score keeps the patch whole in its eligible entry', () =>
  withDir((dir) => {
    // A path that exists, because score rejects a citation of a file that does not.
    const path = 'plugins/review-voice/src/scoring/score.ts';
    const patch = { start_line: 12, end_line: 12, original: ' */', replacement: 'w'.repeat(600) };
    const input = JSON.stringify({ candidates: [candidate(patch, { path, line: 12 })] });
    const verification = join(dir, 'verification.json');
    writeFileSync(
      verification,
      JSON.stringify({ results: [{ candidate_id: 'cand_001', technical_confidence: 0.9, fix_verdict: 'verified', fix_confidence: 0.9, fix_reason: 'Traced.' }] }),
    );
    const scored = cli(['score', '--verification', verification], input, dir);
    assert.equal(scored.code, 0, scored.stderr);
    const [entry] = JSON.parse(scored.stdout).eligible;
    assert.equal(entry.fix.render, 'fix');
    assert.deepEqual(entry.suggested_patch, { ...patch, path }, 'whole, with the path it was checked on');
  }));

// ---------------------------------------------------------------------------
// AC-2 to AC-4: record, the head check, rendering and withholding.
// ---------------------------------------------------------------------------

function fakeGitHub({ file = HEAD_FILE, contentsStatus = 200 } = {}) {
  const calls = [];
  const impl = async (url, init = {}) => {
    const parsed = new URL(String(url));
    const call = { method: init.method ?? 'GET', path: parsed.pathname, search: parsed.search, body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined };
    calls.push(call);
    if (call.method === 'POST') return json({ id: 9, html_url: `https://github.com/${REPO}/pull/${PR}#pullrequestreview-9`, state: call.body.event });
    if (/\/pulls\/\d+$/.test(parsed.pathname)) return json({ head: { sha: HEAD } });
    if (parsed.pathname.endsWith('/check-runs')) return json({ total_count: 1, check_runs: [{ id: 1, name: 'build', status: 'completed', conclusion: 'success', completed_at: '2026-10-01T10:00:00Z' }] });
    if (parsed.pathname.endsWith('/status')) return json({ state: 'success', total_count: 0, statuses: [] });
    if (parsed.pathname.startsWith(`/repos/${REPO}/contents/`)) return contentsStatus === 200 ? contents(file) : new Response('gone', { status: contentsStatus });
    return new Response('not found', { status: 404 });
  };
  impl.calls = calls;
  impl.contentReads = () => calls.filter((c) => c.path.includes('/contents/'));
  return impl;
}

const score = (line, render = 'fix') => ({
  candidateId: 'cand_001',
  path: FILE,
  line,
  severity: { severity: 'blocking' },
  confidenceSource: 'verifier',
  eligible: true,
  fix: { render },
});

/** A run whose one finding is at `line`, from a candidate carrying `patch`. */
function record(db, { line = 85, patch = PATCH, render = 'fix' } = {}) {
  const output = `[blocking] \`${FILE}:${line}\` - ${PROSE}`;
  const hint = { path: FILE, line, category: 'correctness', candidate_id: 'cand_001', ...(patch === undefined ? {} : { suggested_patch: patch }) };
  const recorded = recordRun(db, { repository: REPO, baseRef: null, headRef: HEAD, pullNumber: PR, diff: 'd', output, scores: [score(line, render)], candidates: [hint] });
  return { output, recorded };
}

const verdict = (db, impl, review, policy = { suggestions: true }) =>
  computeVerdict({ db, client: client(impl), repository: REPO, pullNumber: PR, head: HEAD, review, policy });

test('a recorded finding carries the patch from its candidate', async () => {
  await withDb((db) => {
    const { recorded } = record(db);
    assert.deepEqual(recorded.findings[0].suggestedPatch, PATCH);
    assert.equal('suggestedPatch' in record(db, { patch: { ...PATCH, original: 7 } }).recorded.findings[0], false, 'a malformed patch is not stored');
  });
});

test('a verified fix whose original matches the head renders the block on a range ending at the anchor', async () => {
  await withDb(async (db) => {
    const { output } = record(db);
    const impl = fakeGitHub();
    const result = await verdict(db, impl, output);
    assert.equal(result.output.action, 'post', result.output.reasons.join('; '));
    assert.deepEqual(result.output.payload.comments, [
      { path: FILE, line: 85, side: 'RIGHT', body: `**blocking** - ${PROSE}\n\n${BLOCK}`, start_line: 84, start_side: 'RIGHT' },
    ]);
    assert.deepEqual(result.output.withheldSuggestions, []);
    assert.match(result.output.preview, /src\/auth\.ts:84-85\n {2}\*\*blocking\*\*/);
    const [read] = impl.contentReads();
    assert.equal(read.path, `/repos/${REPO}/contents/${FILE}`);
    assert.equal(read.search, `?ref=${HEAD}`);
  });
});

test('a one-line patch sets no range, and an empty replacement renders an empty block', async () => {
  await withDb(async (db) => {
    const { output } = record(db, { patch: { start_line: 85, end_line: 85, original: 'await tx.commit();', replacement: '' } });
    const result = await verdict(db, fakeGitHub(), output);
    assert.deepEqual(result.output.payload.comments, [
      { path: FILE, line: 85, side: 'RIGHT', body: `**blocking** - ${PROSE}\n\n\`\`\`suggestion\n\`\`\`` },
    ]);
  });
});

test('without a verified fix the comment is prose only and the block is withheld visibly', async () => {
  for (const render of ['direction', 'none', null]) {
    await withDb(async (db) => {
      const { output } = record(db, { render });
      const impl = fakeGitHub();
      const result = await verdict(db, impl, output);
      assert.deepEqual(result.output.payload.comments, [{ path: FILE, line: 85, side: 'RIGHT', body: `**blocking** - ${PROSE}` }], String(render));
      assert.deepEqual(result.output.withheldSuggestions, [{ findingId: 'rv_01', path: FILE, line: 85, reason: 'the fix was not verified' }]);
      assert.equal(impl.contentReads().length, 0, 'nothing is read for a block that cannot post');
    });
  }
});

test('a changed head, a failed read or a moved anchor withholds the block and keeps the prose', async () => {
  const cases = [
    { name: 'head lines differ', github: { file: fileWith('res.json(token);\nawait tx.commit(); // changed') }, reason: /lines at the head are not the patch original/ },
    { name: 'read fails', github: { contentsStatus: 404 }, reason: /could not be read at the head/ },
    { name: 'file too short', github: { file: 'one line\n' }, reason: /lines at the head are not the patch original/ },
    { name: 'anchor moved', line: 86, reason: /^anchor moved: the finding is on line 86 and the patch ends on line 85$/, reads: 0 },
  ];
  for (const entry of cases) {
    await withDb(async (db) => {
      const { output } = record(db, { line: entry.line ?? 85 });
      const impl = fakeGitHub(entry.github);
      const result = await verdict(db, impl, output);
      const line = entry.line ?? 85;
      assert.deepEqual(result.output.payload.comments, [{ path: FILE, line, side: 'RIGHT', body: `**blocking** - ${PROSE}` }], entry.name);
      const [withheld] = result.output.withheldSuggestions;
      assert.deepEqual([withheld.findingId, withheld.path, withheld.line], ['rv_01', FILE, line], entry.name);
      assert.match(withheld.reason, entry.reason, entry.name);
      assert.match(result.output.preview, new RegExp(`rv_01 src/auth\\.ts:${line} suggestion withheld \\(`), entry.name);
      if (entry.reads !== undefined) assert.equal(impl.contentReads().length, entry.reads, entry.name);
    });
  }
});

test('verdict and post send the same payload with the block in it', async () => {
  await withDb(async (db) => {
    const { output } = record(db);
    const impl = fakeGitHub();
    const previewed = await verdict(db, impl, output);
    const posted = await postReview({
      db,
      client: client(impl),
      writerFor: (allowlist) => new ReviewWriter({ allowlist, token: 't', fetchImpl: impl }),
      repository: REPO,
      pullNumber: PR,
      head: HEAD,
      review: output,
      confirm: true,
      event: 'REQUEST_CHANGES',
      postingEnabled: true,
      policy: { suggestions: true },
    });
    assert.equal(posted.output.status, 'sent', posted.output.reasons.join('; '));
    const sent = impl.calls.filter((c) => c.method === 'POST');
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0].body, previewed.output.payload);
    assert.ok(sent[0].body.comments[0].body.endsWith(BLOCK));
    assert.equal(posted.output.key, previewed.output.key);
  });
});

test('with suggestions off, a verified patch changes nothing and nothing is read', async () => {
  await withDb(async (db) => {
    const { output } = record(db);
    for (const policy of [{}, { suggestions: false }]) {
      const impl = fakeGitHub();
      const result = await verdict(db, impl, output, policy);
      assert.deepEqual(result.output.payload.comments, [{ path: FILE, line: 85, side: 'RIGHT', body: `**blocking** - ${PROSE}` }]);
      assert.deepEqual(result.output.withheldSuggestions, []);
      assert.equal(impl.contentReads().length, 0);
      assert.doesNotMatch(result.output.preview, /suggestion/);
    }
  });
});

test('the writer refuses a comment range that does not end at its line on the new side', async () => {
  const calls = [];
  const impl = async (url, init) => {
    calls.push(init);
    return json({ id: 1, html_url: 'u', state: 'COMMENTED' });
  };
  const writer = new ReviewWriter({ allowlist: [REPO], token: 't', fetchImpl: impl });
  const payload = (extra) => ({ commit_id: HEAD, event: 'COMMENT', body: 'b', comments: [{ path: FILE, line: 85, side: 'RIGHT', body: 'x', ...extra }] });
  for (const extra of [
    { start_line: 86, start_side: 'RIGHT' },
    { start_line: 0, start_side: 'RIGHT' },
    { start_line: 84.5, start_side: 'RIGHT' },
    { start_line: '84', start_side: 'RIGHT' },
    { start_line: 84, start_side: 'LEFT' },
    { start_line: 84 },
    { start_side: 'RIGHT' },
  ]) {
    await assert.rejects(() => writer.submitReview(REPO, PR, payload(extra)), WriteViolation, JSON.stringify(extra));
  }
  assert.equal(calls.length, 0, 'nothing reached the network');
  await writer.submitReview(REPO, PR, payload({ start_line: 84, start_side: 'RIGHT' }));
  await writer.submitReview(REPO, PR, payload({}));
  assert.equal(calls.length, 2);
});

// ---------------------------------------------------------------------------
// AC-5: an applied suggestion is a strong fixed outcome.
// ---------------------------------------------------------------------------

function outcomesGitHub({ file = APPLIED_FILE, reviewedFile = HEAD_FILE, contentsStatus = 200, posted = `**blocking** - ${PROSE}\n\n${BLOCK}`, comparePatch = `@@ -84,2 +84,2 @@\n-res.json(token);\n-await tx.commit();\n+await tx.commit();\n+res.json(token);` } = {}) {
  const calls = [];
  const comment = {
    id: 301,
    path: FILE,
    line: 85,
    original_line: 85,
    start_line: 84,
    original_start_line: 84,
    body: posted,
    user: { login: 'review-bot-user' },
    created_at: '2026-10-01T10:00:00Z',
  };
  const impl = async (url, init = {}) => {
    const parsed = new URL(String(url));
    const path = parsed.pathname;
    calls.push({ method: init.method ?? 'GET', path, search: parsed.search });
    if (path === '/graphql') {
      const nodes = [{ isResolved: false, isOutdated: false, comments: { nodes: [{ databaseId: 301 }] } }];
      return json({ data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false }, nodes } } } } });
    }
    if (path === '/user') return json({ login: 'review-bot-user' });
    if (path === `/repos/${REPO}/pulls/${PR}`) return json({ head: { sha: NEW_HEAD } });
    if (path === `/repos/${REPO}/pulls/${PR}/comments`) return json([comment]);
    if (/\/pulls\/\d+\/reviews\/\d+\/comments$/.test(path)) return json([comment]);
    if (path.includes('/compare/')) {
      return json({ files: [{ filename: FILE, patch: comparePatch }] });
    }
    if (path.startsWith(`/repos/${REPO}/contents/`)) {
      if (contentsStatus !== 200) return new Response('boom', { status: contentsStatus });
      return contents(parsed.search.includes(NEW_HEAD) ? file : reviewedFile);
    }
    return new Response('not found', { status: 404 });
  };
  impl.contentReads = () => calls.filter((c) => c.path.includes('/contents/'));
  return impl;
}

function postedRun(db, patch) {
  const { reviewRunId } = recordRun(db, {
    repository: REPO,
    baseRef: null,
    headRef: HEAD,
    pullNumber: PR,
    diff: 'd',
    output: BLOCKING,
    candidates: [{ path: FILE, line: 85, category: 'correctness', ...(patch === undefined ? {} : { suggested_patch: patch }) }],
  });
  const subject = { type: 'pull_request', id: `${REPO}#${PR}` };
  const attempt = recordAudit(db, 'review_post_attempted', subject, { run: reviewRunId });
  recordAudit(db, 'review_post_sent', subject, { attempt, head: HEAD, reviewId: 555 });
}

const outcomeOf = async (db, impl) => {
  const result = await checkOutcomes({ db, client: client(impl), allowlist: [REPO], since: '2000-01-01T00:00:00.000Z' });
  assert.equal(result.outcomes.length, 1, result.warnings.join('; '));
  return result.outcomes[0];
};

test('outcomes records an applied suggestion as fixed, read at the current head', async () => {
  await withDb(async (db) => {
    postedRun(db, PATCH);
    const impl = outcomesGitHub();
    const outcome = await outcomeOf(db, impl);
    assert.deepEqual([outcome.outcome, outcome.strength, outcome.evidence], ['fixed', 'strong', 'suggestion applied']);
    const reads = impl.contentReads();
    assert.ok(reads.every((read) => read.path === `/repos/${REPO}/contents/${FILE}`));
    assert.deepEqual(reads.map((read) => read.search).sort(), [`?ref=${HEAD}`, `?ref=${NEW_HEAD}`].sort(), 'the reviewed head and the current head');
  });
});

test('an empty replacement, other text or a failed read falls through to the existing rules', async () => {
  const cases = [
    { name: 'deletion', patch: { start_line: 85, end_line: 85, original: 'await tx.commit();', replacement: '' }, github: {}, reads: 0 },
    { name: 'not applied', patch: PATCH, github: { file: HEAD_FILE }, reads: 2 },
    { name: 'read fails', patch: PATCH, github: { contentsStatus: 500 }, reads: 2 },
    { name: 'no patch', patch: undefined, github: {}, reads: 0 },
  ];
  for (const entry of cases) {
    await withDb(async (db) => {
      postedRun(db, entry.patch);
      const impl = outcomesGitHub(entry.github);
      const outcome = await outcomeOf(db, impl);
      // The lines changed and the thread is open, which the existing rules call outdated.
      assert.deepEqual([outcome.outcome, outcome.strength], ['outdated', 'weak'], `${entry.name}: ${outcome.evidence}`);
      assert.equal(impl.contentReads().length, entry.reads, entry.name);
    });
  }
});

// ---------------------------------------------------------------------------
// AC-6: prompts, ADR, index, example config and help.
// ---------------------------------------------------------------------------

test('the prompts, the ADR, its index, the example config and help document suggestions', () => {
  assert.match(read('plugins/review-voice/agents/diff-analyst.md'), /`suggested_patch`/);
  assert.match(read('plugins/review-voice/agents/evidence-verifier.md'), /`suggested_patch`/);

  const adr = readdirSync(join(root, 'docs/adr')).find((name) => name.startsWith('0033-'));
  assert.equal(adr, '0033-committable-suggestions-are-verified-patches.md');
  const index = read('docs/adr/README.md');
  assert.ok(index.includes(`(${adr})`), 'the index lists 0033');
  const row = index.split('\n').find((line) => line.startsWith('| [0029]'));
  assert.match(row, /0033/, 'the 0029 row names the amending ADR');

  const amended = readdirSync(join(root, 'docs/adr')).find((name) => name.startsWith('0029-'));
  const adr0029 = read(join('docs/adr', amended));
  assert.match(adr0029, /^## Amendment - 2026/m);
  assert.match(adr0029, /applied suggestion/i);
  assert.ok(adr0029.includes('suggestion applied'));

  const example = read('plugins/review-voice/templates/config.example.yaml');
  assert.match(example, /^ {2}suggestions: false$/m);
  const dir = mkdtempSync(join(tmpdir(), 'rv-s14-example-'));
  try {
    mkdirSync(join(dir, '.review-voice'));
    writeFileSync(join(dir, '.review-voice', 'config.yaml'), example);
    const config = loadConfig(dir);
    assert.deepEqual(config.warnings, []);
    assert.equal(config.verdictPolicy.suggestions, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  const help = (command) => execFileSync(process.execPath, [bundle, command, '--help'], { encoding: 'utf8' });
  assert.match(help('verdict'), /review\.suggestions: false/);
  assert.match(help('check-candidates'), /suggested_patch/);
  assert.match(read('docs/ARCHITECTURE.md'), /review\.suggestions/);
});

test('a finding posted without its block is not sent again with it on a later post of the head', async () => {
  await withDb(async (db) => {
    const { output } = record(db);
    const post = (impl, event) => postReview({
      db,
      client: client(impl),
      writerFor: (allowlist) => new ReviewWriter({ allowlist, token: 't', fetchImpl: impl }),
      repository: REPO,
      pullNumber: PR,
      head: HEAD,
      review: output,
      confirm: true,
      event,
      postingEnabled: true,
      policy: { suggestions: true },
    });
    const failing = fakeGitHub({ contentsStatus: 500 });
    const first = await post(failing, 'REQUEST_CHANGES');
    assert.equal(first.output.status, 'sent', first.output.reasons.join('; '));
    const firstComments = failing.calls.filter((c) => c.method === 'POST')[0].body.comments;
    assert.equal(firstComments.length, 1);
    assert.equal(firstComments[0].body.includes('```suggestion'), false, 'the read failed, so no block');

    const working = fakeGitHub();
    await post(working, 'REQUEST_CHANGES');
    const later = working.calls.filter((c) => c.method === 'POST').flatMap((c) => c.body.comments ?? []);
    assert.equal(later.filter((c) => c.path === FILE && c.line === 85).length, 0, 'the finding is already on the pull request');
  });
});

test('the editor prompt never carries the replacement code', async () => {
  const { editorPrompt } = await import('../plugins/review-voice/src/review/prompts.ts');
  const prompt = editorPrompt([{ claim: PROSE, fix: { render: 'fix', text: 'commit first' }, suggested_patch: PATCH }], null);
  assert.equal(prompt.includes(REPLACEMENT), false);
  assert.equal(prompt.includes('suggested_patch'), false);
  assert.ok(prompt.includes('commit first'));
});

// Codex review of S14: a patch is tied to its own candidate and file, and an
// applied suggestion needs a posted block standing between the same lines.

test('a patch never posts on another candidate verified fix at the same location', async () => {
  await withDb(async (db) => {
    const scores = [
      { ...score(85), candidateId: 'cand_001' },
      { ...score(85, 'none'), candidateId: 'cand_002' },
    ];
    const hints = [
      { path: FILE, line: 85, category: 'correctness', candidate_id: 'cand_002', suggested_patch: PATCH },
      { path: FILE, line: 85, category: 'correctness', candidate_id: 'cand_001' },
    ];
    recordRun(db, { repository: REPO, baseRef: null, headRef: HEAD, pullNumber: PR, diff: 'd', output: BLOCKING, scores, candidates: hints });
    const impl = fakeGitHub();
    const result = await verdict(db, impl, BLOCKING);
    const comment = result.output.payload.comments[0];
    assert.equal(comment.body.includes('```suggestion'), false, 'the patch belongs to the candidate whose fix was refuted');
    assert.match(result.output.withheldSuggestions.map((w) => w.reason).join('; '), /another candidate/);
  });
});

test('a finding moved to another file withholds the patch written for the first', async () => {
  await withDb(async (db) => {
    const OTHER = 'src/other.ts';
    const output = `[blocking] \`${OTHER}:85\` - ${PROSE}`;
    const hints = [{ path: FILE, line: 85, category: 'correctness', candidate_id: 'cand_001', suggested_patch: PATCH }];
    recordRun(db, { repository: REPO, baseRef: null, headRef: HEAD, pullNumber: PR, diff: 'd', output, scores: [{ ...score(85), path: OTHER }], candidates: hints });
    const result = await verdict(db, fakeGitHub(), output);
    for (const comment of result.output.payload.comments) assert.equal(comment.body.includes('```suggestion'), false);
  });
});

test('outcomes never counts a suggestion applied when no block was posted or only a prefix matches', async () => {
  const SHORT = { start_line: 84, end_line: 85, original: ORIGINAL, replacement: 'res.json(token);' };
  const edited = fileWith('res.json(token);\nawait tx.commit(options);');
  for (const entry of [
    { name: 'no block posted', patch: PATCH, github: { posted: `**blocking** - ${PROSE}` } },
    { name: 'a prefix of the original still stands', patch: SHORT, github: { file: edited } },
  ]) {
    await withDb(async (db) => {
      postedRun(db, entry.patch);
      const outcome = await outcomeOf(db, outcomesGitHub(entry.github));
      assert.notEqual(outcome.evidence, 'suggestion applied', entry.name);
    });
  }
});

test('a shorter replacement that was applied is recognised', async () => {
  const SHORT = { start_line: 84, end_line: 85, original: ORIGINAL, replacement: 'await tx.commit();' };
  await withDb(async (db) => {
    postedRun(db, SHORT);
    const block = '```suggestion\nawait tx.commit();\n```';
    const outcome = await outcomeOf(db, outcomesGitHub({ file: fileWith('await tx.commit();'), posted: `**blocking** - ${PROSE}\n\n${block}` }));
    assert.equal(outcome.evidence, 'suggestion applied');
  });
});

// Codex review of S14, second round.

test('reanchor leaves a moved candidate patch behind, and keeps it when nothing moves', async () => {
  const { reanchorCandidates } = await import('../plugins/review-voice/src/diff/reanchor.ts');
  const list = [{ candidate_id: 'cand_001', path: FILE, line: 85, suggested_patch: PATCH }, { candidate_id: 'cand_002', path: FILE, line: 90, suggested_patch: PATCH }];
  const moved = reanchorCandidates(list, 'cand_001', { path: 'src/b.ts', line: 85 });
  assert.equal('suggested_patch' in moved[0], false, 'checked against other lines');
  assert.deepEqual([moved[0].path, moved[0].line], ['src/b.ts', 85]);
  assert.deepEqual(moved[1], list[1], 'another candidate is untouched');
  const stayed = reanchorCandidates(list, 'cand_001', { path: FILE, line: 85 });
  assert.deepEqual(stayed[0].suggested_patch, PATCH);
});

test('an applied suggestion that only inserts beside an unchanged anchor is recognised', async () => {
  const INSERT = { start_line: 85, end_line: 85, original: 'await tx.commit();', replacement: 'log(token);\nawait tx.commit();' };
  const block = '```suggestion\nlog(token);\nawait tx.commit();\n```';
  await withDb(async (db) => {
    postedRun(db, INSERT);
    const outcome = await outcomeOf(db, outcomesGitHub({
      file: fileWith('res.json(token);\nlog(token);\nawait tx.commit();'),
      reviewedFile: HEAD_FILE,
      posted: `**blocking** - ${PROSE}\n\n${block}`,
      comparePatch: '@@ -84,0 +85,1 @@\n+log(token);',
    }));
    assert.equal(outcome.evidence, 'suggestion applied');
  });
});

test('a replacement written with CRLF line endings is recognised once applied', async () => {
  const CRLF = { ...PATCH, replacement: 'await tx.commit();\r\nres.json(token);' };
  await withDb(async (db) => {
    postedRun(db, CRLF);
    const outcome = await outcomeOf(db, outcomesGitHub({ file: fileWith(REPLACEMENT).split('\n').join('\r\n') }));
    assert.equal(outcome.evidence, 'suggestion applied');
  });
});

// Codex review of S14, third round.

test('a scored entry moved to another file keeps the path its patch was checked on, so posting withholds it', async () => {
  await withDb(async (db) => {
    const OTHER = 'src/other.ts';
    const output = `[blocking] \`${OTHER}:85\` - ${PROSE}`;
    // What reanchor leaves in the eligible list: the entry moved, the patch did not.
    const hints = [{ path: OTHER, line: 85, category: 'correctness', candidate_id: 'cand_001', suggested_patch: { ...PATCH, path: FILE } }];
    recordRun(db, { repository: REPO, baseRef: null, headRef: HEAD, pullNumber: PR, diff: 'd', output, scores: [{ ...score(85), path: OTHER }], candidates: hints });
    const result = await verdict(db, fakeGitHub({ file: HEAD_FILE }), output);
    assert.equal(result.output.payload.comments[0].body.includes('```suggestion'), false);
    assert.match(result.output.withheldSuggestions.map((w) => w.reason).join('; '), new RegExp(`written for ${FILE}`));
  });
});

test('a patch that changes nothing once line endings are read the same way is withheld', async () => {
  await withDb(async (db) => {
    const { output } = record(db, { patch: { ...PATCH, replacement: ORIGINAL.split('\n').join('\r\n') } });
    const result = await verdict(db, fakeGitHub(), output);
    assert.equal(result.output.payload.comments[0].body.includes('```suggestion'), false);
    assert.match(result.output.withheldSuggestions.map((w) => w.reason).join('; '), /does not change the lines/);
  });
});

test('an unchanged file never proves a suggestion applied, even with a repeated neighbouring line', async () => {
  const repeated = fileWith('audit();\naudit();\naudit();');
  const cases = [
    { name: 'repeated neighbour', patch: { start_line: 84, end_line: 85, original: 'audit();\naudit();', replacement: 'audit();' } },
    { name: 'line endings only', patch: { start_line: 84, end_line: 85, original: 'audit();\naudit();', replacement: 'audit();\r\naudit();' } },
  ];
  for (const entry of cases) {
    await withDb(async (db) => {
      postedRun(db, entry.patch);
      const outcome = await outcomeOf(db, outcomesGitHub({ file: repeated, reviewedFile: repeated, comparePatch: '' }));
      assert.notEqual(outcome.evidence, 'suggestion applied', entry.name);
    });
  }
});

// Codex review of S14, fourth round: absolute positions are not tracking.
test('lines inserted above the range never make an unapplied suggestion look applied', async () => {
  const reviewed = '\nsafe();\n\nunsafe();\n\nend();\n';
  const shifted = `\n\n${reviewed}`;
  const patch = { start_line: 4, end_line: 4, original: 'unsafe();', replacement: 'safe();' };
  await withDb(async (db) => {
    postedRun(db, patch);
    const block = '```suggestion\nsafe();\n```';
    const outcome = await outcomeOf(db, outcomesGitHub({ file: shifted, reviewedFile: reviewed, posted: `**blocking** - ${PROSE}\n\n${block}`, comparePatch: '@@ -0,0 +1,2 @@\n+\n+' }));
    assert.notEqual(outcome.evidence, 'suggestion applied');
  });
});

test('an applied suggestion still counts when the author also edited lines below it', async () => {
  await withDb(async (db) => {
    postedRun(db, PATCH);
    const outcome = await outcomeOf(db, outcomesGitHub({ file: `${fileWith(REPLACEMENT)}// a later edit\n` }));
    assert.equal(outcome.evidence, 'suggestion applied');
  });
});
