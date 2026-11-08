/**
 * S15. The collapsed evidence block posted after each inline comment under
 * `verdict.evidence_block`, with its shape and sources, the identities it must not
 * move, the flattening of every stored string, what it never carries, and the
 * readers that strip it before comparing words.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../plugins/review-voice/src/store/db.ts';
import { loadConfig } from '../plugins/review-voice/src/policy/load.ts';
import { recordRun } from '../plugins/review-voice/src/store/runs.ts';
import { recordAudit } from '../plugins/review-voice/src/store/audit.ts';
import { GitHubClient } from '../plugins/review-voice/src/github/client.ts';
import { ReviewWriter } from '../plugins/review-voice/src/github/writer.ts';
import { computeVerdict, postReview } from '../plugins/review-voice/src/publish/post.ts';
import { ciAnnotations, commentSignature, safeCheckName } from '../plugins/review-voice/src/publish/verdict.ts';
import { EVIDENCE_MARKER, evidenceBlock, stripEvidenceBlock } from '../plugins/review-voice/src/publish/evidence-block.ts';
import { readThread } from '../plugins/review-voice/src/diff/thread.ts';
import { alreadySaidOnThread, normaliseCandidate } from '../plugins/review-voice/src/scoring/score.ts';
import { checkOutcomes } from '../plugins/review-voice/src/store/outcomes.ts';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (path) => readFileSync(join(root, path), 'utf8');

const HEAD = 'a'.repeat(40);
const NEW_HEAD = 'b'.repeat(40);
const REPO = 'acme/web';
const PR = 7;
const OWNER = 'your-github-login';

const PROSE = 'The total skips the discount. A discounted cart is overcharged.';
const MINOR = `[minor] \`src/cart.ts:12\` - ${PROSE}`;
const NIT = '[nit] `src/cart.ts:40` - This name shadows the import.';
const POSTED = `**minor** - ${PROSE}`;

const CHALLENGE = { verdict: 'confirmed', line_ok: true, decisive_evidence: ['src/cart.ts:12', 'src/pricing.ts:48'], reason: '' };
const PRECEDENTS = [
  { eventId: 'ev_1', role: 'owner', polarity: 'positive', excerpt: 'An owner excerpt.', reviewerLogin: 'precedent-login' },
  { eventId: 'ev_2', role: 'owner', polarity: 'positive', excerpt: 'Another owner excerpt.', reviewerLogin: 'precedent-login' },
  { eventId: 'ev_3', role: 'peer', polarity: 'positive', excerpt: 'A peer excerpt.', reviewerLogin: 'peer-login' },
];
const score = (over = {}) => ({
  candidateId: 'cart',
  path: 'src/cart.ts',
  line: 12,
  severity: { severity: 'minor' },
  confidenceSource: 'verifier',
  eligible: true,
  challenge: CHALLENGE,
  precedents: PRECEDENTS,
  ...over,
});
const nitScore = (over = {}) => ({ ...score({ candidateId: 'nit', line: 40, severity: { severity: 'nit' } }), challenge: { ...CHALLENGE, decisive_evidence: ['src/cart.ts:40'] }, ...over });

const SIGNAL = { kind: 'type', path: 'src/cart.ts', line: 12, claim: 'Type error.', evidence: ["Object is possibly 'undefined'."], confidence: 1, tool: 'typecheck' };
const CONVENTIONS = [{ path: 'CONTRIBUTING.md', content: '# Contributing\n\nTotals are computed\nafter discounts, always.\n' }];
const HINT = { candidate_id: 'cart', path: 'src/cart.ts', line: 12, category: 'correctness', evidence: ['CONTRIBUTING.md says "totals are computed after discounts".'] };

const BLOCK = [
  EVIDENCE_MARKER,
  '<details><summary>Evidence</summary>',
  '',
  'Verified by the evidence verifier. Challenger: confirmed, line confirmed.',
  'Decisive lines: `src/cart.ts:12`, `src/pricing.ts:48`.',
  "Static check `typecheck` also flagged this line: `Object is possibly 'undefined'.`",
  'Convention `CONTRIBUTING.md` says `totals are computed after discounts`.',
  'Owner precedents in favour: 2 of 3 retrieved.',
  '',
  '</details>',
].join('\n');

const ON = { evidenceBlock: true, evidenceBlockPrecedents: true };

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const check = (conclusion) => ({ id: 1, name: 'build', status: 'completed', conclusion, completed_at: '2026-11-01T10:00:00Z' });
const GREEN = [check('success')];
const RED = [check('failure')];

function fakeGitHub({ checks = GREEN, reviews = [], contents = null } = {}) {
  const posts = [];
  const impl = async (url, init = {}) => {
    const parsed = new URL(String(url));
    const path = parsed.pathname;
    if (init.method === 'POST') {
      posts.push(JSON.parse(init.body));
      return json({ id: 101, html_url: `https://github.com/${REPO}/pull/${PR}#pullrequestreview-101`, state: posts.at(-1).event });
    }
    if (/\/pulls\/\d+$/.test(path)) return json({ head: { sha: HEAD } });
    if (path.endsWith('/reviews')) return json(reviews);
    if (path.endsWith('/check-runs')) return json({ total_count: checks.length, check_runs: checks });
    if (path.endsWith('/status')) return json({ state: 'success', total_count: 0, statuses: [] });
    if (contents !== null && path.startsWith(`/repos/${REPO}/contents/`)) {
      return json({ type: 'file', encoding: 'base64', content: Buffer.from(contents, 'utf8').toString('base64') });
    }
    return new Response('not found', { status: 404 });
  };
  impl.posts = posts;
  return impl;
}

const client = (impl) => new GitHubClient({ allowlist: [REPO], token: 't', fetchImpl: impl, sleep: async () => {} });

async function withDb(body) {
  const dir = mkdtempSync(join(tmpdir(), 'rv-s15-'));
  const previous = process.env.REVIEW_VOICE_DATA_DIR;
  process.env.REVIEW_VOICE_DATA_DIR = dir;
  const db = openDatabase(join(dir, 'review-voice.db'));
  try {
    await body(db);
  } finally {
    db.close();
    if (previous === undefined) delete process.env.REVIEW_VOICE_DATA_DIR;
    else process.env.REVIEW_VOICE_DATA_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  }
}

function record(db, extra = {}) {
  return recordRun(db, {
    repository: REPO,
    baseRef: null,
    headRef: HEAD,
    pullNumber: PR,
    diff: 'diff',
    output: MINOR,
    scores: [score()],
    candidates: [HINT],
    toolSignals: [SIGNAL],
    conventions: CONVENTIONS,
    ...extra,
  });
}

const verdict = (db, impl, extra = {}) =>
  computeVerdict({ db, client: client(impl), repository: REPO, pullNumber: PR, head: HEAD, review: MINOR, ...extra });

const post = (db, impl, extra = {}) =>
  postReview({
    db,
    client: client(impl),
    writerFor: (allowlist) => new ReviewWriter({ allowlist, token: 't', fetchImpl: impl }),
    repository: REPO,
    pullNumber: PR,
    head: HEAD,
    review: MINOR,
    confirm: true,
    event: 'COMMENT',
    postingEnabled: true,
    ...extra,
  });

const audits = (db, action) =>
  db.prepare('SELECT metadata_json FROM audit_events WHERE action = ? ORDER BY created_at, rowid').all(action).map((row) => JSON.parse(row.metadata_json));

/** The block of a posted body, from its marker on. */
const blockOf = (body) => (body.includes(EVIDENCE_MARKER) ? body.slice(body.indexOf(EVIDENCE_MARKER)) : '');

// ---------------------------------------------------------------------------
// AC-1: off by default, and off changes nothing.
// ---------------------------------------------------------------------------

test('with both settings off the payload and post are unchanged and evidenceBlocks is 0', async () => {
  await withDb(async (db) => {
    record(db);
    for (const policy of [undefined, {}, { evidenceBlock: false, evidenceBlockPrecedents: true }]) {
      const { output } = await verdict(db, fakeGitHub(), { policy });
      assert.equal(output.action, 'post', output.reasons.join('; '));
      assert.deepEqual(output.payload.comments, [{ path: 'src/cart.ts', line: 12, side: 'RIGHT', body: POSTED }]);
      assert.equal(output.evidenceBlocks, 0);
      assert.doesNotMatch(output.preview, /review-voice evidence/);
    }
    const impl = fakeGitHub();
    const sent = await post(db, impl, { policy: { evidenceBlock: false } });
    assert.equal(sent.output.status, 'sent', sent.output.reasons.join('; '));
    assert.deepEqual(impl.posts, [{ commit_id: HEAD, event: 'COMMENT', body: '1 comment, the highest minor.', comments: [{ path: 'src/cart.ts', line: 12, side: 'RIGHT', body: POSTED }] }]);
    assert.equal(audits(db, 'review_post_attempted')[0].evidenceBlocks, 0);

    const refused = await verdict(db, fakeGitHub(), { head: 'abc' });
    assert.equal(refused.output.action, 'refuse');
    assert.equal(refused.output.evidenceBlocks, 0);
  });
});

// ---------------------------------------------------------------------------
// AC-2: the block, from the stored finding and its backing score.
// ---------------------------------------------------------------------------

test('the block follows the prose in the specified shape, built from the recorded run', async () => {
  await withDb(async (db) => {
    record(db);
    const previewed = await verdict(db, fakeGitHub(), { policy: ON });
    assert.deepEqual(previewed.output.payload.comments, [{ path: 'src/cart.ts', line: 12, side: 'RIGHT', body: `${POSTED}\n\n${BLOCK}` }]);
    assert.equal(previewed.output.evidenceBlocks, 1);
    assert.ok(previewed.output.preview.includes(`src/cart.ts:12\n  ${POSTED}\n\n${BLOCK}`));

    const impl = fakeGitHub();
    const sent = await post(db, impl, { policy: ON });
    assert.equal(sent.output.status, 'sent', sent.output.reasons.join('; '));
    assert.deepEqual(impl.posts, [previewed.output.payload], 'verdict and post carry the same block');
    assert.equal(sent.output.key, previewed.output.key);
  });
});

test('no challenge reads not run, and a moved anchor names the line it moved from, not the corrected one', () => {
  const finding = undefined;
  const none = evidenceBlock(finding, score({ challenge: undefined }), { evidenceBlockPrecedents: false });
  assert.ok(none.includes('\nVerified by the evidence verifier. Challenger: not run.\n'));
  assert.doesNotMatch(none, /Decisive lines/);

  const moved = score({ line: 14, challenge: { ...CHALLENGE, line_ok: false, corrected_line: 14 }, reanchoredFrom: { path: 'src/cart.ts', line: 9 } });
  const block = evidenceBlock(finding, moved, { evidenceBlockPrecedents: false });
  assert.ok(block.includes('\nVerified by the evidence verifier. Challenger: confirmed, anchor moved from line 9.\n'), block);
  assert.doesNotMatch(block, /line 14/);
  assert.equal(evidenceBlock(finding, null, ON), '', 'no score, no block');
});

test('a carried finding renders from the origin run stored finding and score', async () => {
  await withDb(async (db) => {
    const origin = record(db);
    // The carried run scored nothing; its finding points back at the origin.
    const carried = record(db, { scores: [], candidates: [], toolSignals: [], conventions: [] });
    const row = db.prepare('SELECT output_json FROM review_runs WHERE review_run_id = ?').get(carried.reviewRunId);
    const parsed = JSON.parse(row.output_json);
    parsed.findings[0].carriedFrom = { runId: origin.reviewRunId, findingId: 'rv_01' };
    db.prepare('UPDATE review_runs SET output_json = ? WHERE review_run_id = ?').run(JSON.stringify(parsed), carried.reviewRunId);
    assert.equal(parsed.findings[0].toolSignal, undefined);

    const { output } = await verdict(db, fakeGitHub(), { policy: ON, runId: carried.reviewRunId });
    assert.equal(output.run, carried.reviewRunId);
    assert.equal(output.payload.comments[0].body, `${POSTED}\n\n${BLOCK}`);
  });
});

test('a decisive entry that fails the pattern or names an absolute or climbing path is dropped', () => {
  const decisive = [
    'src/cart.ts:12',
    'not a reference',
    'src/cart.ts',
    '/Users/someone/.review-voice/runs/1/head/src/cart.ts:12',
    '../outside.ts:3',
    'src/../../etc/passwd:1',
    'C:\\work\\cart.ts:4',
    '~/cart.ts:5',
    'file:///tmp/cart.ts:6',
    '  src/ok.ts:7-9  ',
    7,
    // Each hides its leading slash, home or climb from a check made before flattening.
    '`/Users/someone/.review-voice/runs/1/head/src/cart.ts`:12',
    '\u200b/Users/someone/x.ts:12',
    '\u0001/etc/passwd:1',
    '\u202e~/secret.ts:5',
    '`~`/x.ts:2',
    'src/`..`/`..`/etc/hosts:1',
    'src/.\u200b./secret.ts:3',
    '`C`:\\work\\x.ts:4',
    '\u2060/Users/someone/secret.ts:12',
    '\u00ad~/secret.ts:5',
    'src//Users/someone/x.ts:1',
    // A path after a word, or prose the challenger wrote, is not one reference.
    'the run copy at /Users/someone/.review-voice/runs/r1/head/src/cart.ts:12',
    'see ~/work/cart.ts:4',
    'see ../outside/cart.ts:3',
    'model claude-opus-5-5 at 0.92 confidence, precedent ev_17 by reviewer-login, see src/cart.ts:12',
  ];
  const block = evidenceBlock(undefined, score({ challenge: { ...CHALLENGE, decisive_evidence: decisive } }), { evidenceBlockPrecedents: false });
  assert.ok(block.includes('\nDecisive lines: `src/cart.ts:12`, `src/ok.ts:7-9`.\n'), block);

  const dropped = evidenceBlock(undefined, score({ challenge: { ...CHALLENGE, decisive_evidence: ['/abs/a.ts:1', 'no'] } }), { evidenceBlockPrecedents: false });
  assert.doesNotMatch(dropped, /Decisive lines/);

  const many = Array.from({ length: 9 }, (_, i) => `src/f${i}.ts:${i + 1}`);
  const capped = evidenceBlock(undefined, score({ challenge: { ...CHALLENGE, decisive_evidence: many } }), { evidenceBlockPrecedents: false });
  assert.ok(capped.includes(`Decisive lines: ${many.slice(0, 6).map((d) => `\`${d}\``).join(', ')}.`), 'six at most');
});

test('the precedent count needs its own key and one retrieved, and counts only owner and positive', () => {
  const precedents = [
    { role: 'owner', polarity: 'positive' },
    { role: 'owner', polarity: 'negative' },
    { role: 'peer', polarity: 'positive' },
    'not a precedent',
  ];
  const line = (policy, list) => evidenceBlock(undefined, score({ precedents: list }), policy).split('\n').find((l) => l.startsWith('Owner precedents'));
  assert.equal(line({ evidenceBlockPrecedents: false }, precedents), undefined);
  assert.equal(line({ evidenceBlockPrecedents: true }, []), undefined);
  assert.equal(line({ evidenceBlockPrecedents: true }, undefined), undefined);
  assert.equal(line({ evidenceBlockPrecedents: true }, precedents), 'Owner precedents in favour: 1 of 4 retrieved.');
  assert.equal(line({ evidenceBlockPrecedents: true }, [{ role: 'peer', polarity: 'positive' }]), 'Owner precedents in favour: 0 of 1 retrieved.');
});

test('evidenceBlocks counts the comments that carry a block', async () => {
  await withDb(async (db) => {
    record(db, { output: `${MINOR}\n\n${NIT}`, scores: [score(), nitScore()] });
    const { output } = await verdict(db, fakeGitHub(), { review: `${MINOR}\n\n${NIT}`, policy: { evidenceBlock: true } });
    assert.equal(output.payload.comments.length, 2);
    assert.equal(output.evidenceBlocks, output.payload.comments.filter((c) => c.body.includes(EVIDENCE_MARKER)).length);
    assert.equal(output.evidenceBlocks, 2);
    // Each block is its own finding's, so the nit carries none of the minor's facts.
    const minorBlock = BLOCK.split('\n').filter((l) => !l.startsWith('Owner precedents')).join('\n');
    const nitBlock = [EVIDENCE_MARKER, '<details><summary>Evidence</summary>', '', 'Verified by the evidence verifier. Challenger: confirmed, line confirmed.', 'Decisive lines: `src/cart.ts:40`.', '', '</details>'].join('\n');
    assert.deepEqual(output.payload.comments.map((c) => c.body), [`${POSTED}\n\n${minorBlock}`, `**nit** - This name shadows the import.\n\n${nitBlock}`]);
  });
});

// ---------------------------------------------------------------------------
// AC-3: the key and the signatures do not move.
// ---------------------------------------------------------------------------

test('the idempotency key and every comment signature are the same with the block on and off', async () => {
  await withDb(async (db) => {
    record(db, { output: `${MINOR}\n\n${NIT}`, scores: [score(), nitScore()] });
    const review = `${MINOR}\n\n${NIT}`;
    const off = (await verdict(db, fakeGitHub(), { review, policy: {} })).output;
    const on = (await verdict(db, fakeGitHub(), { review, policy: ON })).output;
    assert.equal(on.key, off.key);
    assert.notDeepEqual(on.payload.comments, off.payload.comments);
    assert.deepEqual(on.payload.comments.map(commentSignature), off.payload.comments.map(commentSignature));
  });
});

test('a COMMENT sent under one setting and the APPROVE under the other send no inline comment twice', async () => {
  for (const [before, after] of [[{}, ON], [ON, {}]]) {
    await withDb(async (db) => {
      record(db, { output: NIT, scores: [nitScore()] });
      const first = fakeGitHub({ checks: RED });
      const capped = await post(db, first, { review: NIT, event: 'COMMENT', policy: before });
      assert.equal(capped.output.status, 'sent', capped.output.reasons.join('; '));
      assert.equal(first.posts[0].comments.length, 1);
      assert.equal(first.posts[0].comments[0].body.includes(EVIDENCE_MARKER), before.evidenceBlock === true);

      const second = fakeGitHub();
      const approved = await post(db, second, { review: NIT, event: 'APPROVE', policy: after });
      assert.equal(approved.output.status, 'sent', approved.output.reasons.join('; '));
      assert.equal(second.posts[0].event, 'APPROVE');
      assert.deepEqual(second.posts[0].comments, [], 'the finding is already on the pull request');
      assert.equal(approved.output.verdict.alreadyInline, 1);
      assert.equal(approved.output.verdict.evidenceBlocks, 0);
    });
  }
});

test('the attempted audit row records how many comments carried a block', async () => {
  await withDb(async (db) => {
    record(db);
    const sent = await post(db, fakeGitHub(), { policy: ON });
    assert.equal(sent.output.status, 'sent', sent.output.reasons.join('; '));
    const [attempt] = audits(db, 'review_post_attempted');
    assert.equal(attempt.evidenceBlocks, 1);
    assert.equal(typeof attempt.run, 'string');
  });
});

const ORIGINAL = 'const total = sum(items);';
const REPLACEMENT = 'const total = sum(items) - discount;';
const PATCH = { start_line: 12, end_line: 12, original: ORIGINAL, replacement: REPLACEMENT };
const SUGGESTION = `\`\`\`suggestion\n${REPLACEMENT}\n\`\`\``;
const fileWith = (line12) => [...Array.from({ length: 11 }, (_, i) => `// line ${i + 1}`), line12, 'return total;', ''].join('\n');

test('with suggestions on, the evidence block follows the suggestion block and the signature ignores both', async () => {
  await withDb(async (db) => {
    record(db, {
      scores: [score({ fix: { render: 'fix' } })],
      candidates: [{ ...HINT, candidate_id: 'cart', suggested_patch: PATCH }],
    });
    const { output } = await verdict(db, fakeGitHub({ contents: fileWith(ORIGINAL) }), { policy: { ...ON, suggestions: true } });
    assert.deepEqual(output.withheldSuggestions, []);
    const [comment] = output.payload.comments;
    assert.equal(comment.body, `${POSTED}\n\n${SUGGESTION}\n\n${BLOCK}`);
    const plain = { path: 'src/cart.ts', line: 12, side: 'RIGHT', body: POSTED };
    for (const body of [POSTED, `${POSTED}\n\n${SUGGESTION}`, `${POSTED}\n\n${BLOCK}`, comment.body]) {
      assert.equal(commentSignature({ ...plain, body }), commentSignature(plain), body);
    }
  });
});

test('a suggestion whose replacement holds the marker after a blank line keeps one signature', () => {
  const plain = { path: 'docs/a.md', line: 3, side: 'RIGHT', body: '**minor** - The heading skips a level.' };
  const suggested = `${plain.body}\n\n\`\`\`suggestion\nintro\n\n${EVIDENCE_MARKER}\n<details>\n\`\`\``;
  const block = evidenceBlock(undefined, score(), { evidenceBlockPrecedents: false });
  assert.equal(stripEvidenceBlock(suggested), suggested, 'no block, so nothing is cut');
  assert.equal(stripEvidenceBlock(`${suggested}\n\n${block}`), suggested);
  for (const body of [suggested, `${suggested}\n\n${block}`, `${plain.body}\n\n${block}`]) {
    assert.equal(commentSignature({ ...plain, body }), commentSignature(plain), body);
  }
});

test('evidence_block alone loads the block without the precedent count', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rv-s15-config-'));
  try {
    mkdirSync(join(dir, '.review-voice'));
    writeFileSync(join(dir, '.review-voice', 'config.yaml'), 'verdict:\n  evidence_block: true\n');
    const config = loadConfig(dir);
    assert.deepEqual(config.warnings, []);
    assert.equal(config.verdictPolicy.evidenceBlock, true);
    assert.equal(config.verdictPolicy.evidenceBlockPrecedents, false);
    await withDb(async (db) => {
      record(db);
      const { output } = await verdict(db, fakeGitHub(), { policy: config.verdictPolicy });
      assert.equal(output.evidenceBlocks, 1);
      assert.doesNotMatch(output.payload.comments[0].body, /Owner precedents/);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// AC-4: every stored string is flattened and capped.
// ---------------------------------------------------------------------------

test('decisive paths, tool text and quotes lose backticks, bidi, zero-width and control characters and are cut by code point', () => {
  // U+202E and U+200B, and other format characters such as the marks, the
  // word joiner, the soft hyphen, an interlinear annotation and a tag character.
  const invisible = '\u202e\u200b\u200e\u200f\u061c\u2060\u00ad\u180e\ufff9\u{e0041}';
  const hostile = `a\`b${invisible}cd\u0007e`;
  // Each emoji is the last code point kept before the ellipsis, where a cut by
  // code unit would split its surrogate pair.
  const longPath = `src/${'w'.repeat(114)}\u{1f600}${'w'.repeat(30)}.ts:12`;
  const longText = `${'t'.repeat(151)}\u{1f600}${'x'.repeat(40)}`;
  const finding = {
    findingId: 'rv_01', severity: 'minor', path: 'src/cart.ts', line: 12, text: MINOR,
    toolSignal: { tool: `type${hostile}`, line: 12, text: `${hostile} ${longText}` },
    conventionQuotes: [{ path: `docs/${hostile}.md`, quote: `${hostile} ${longText}` }],
    conventionQuotesCandidate: 'cart',
  };
  // A control character inside a path becomes a space, which drops the entry,
  // so here it leads and is trimmed.
  const block = evidenceBlock(finding, score({ challenge: { ...CHALLENGE, decisive_evidence: [`\u0007src/a\`b${invisible}cd.ts:12`, longPath] } }), { evidenceBlockPrecedents: false });
  for (const banned of [...invisible, '\u0007']) assert.equal(block.includes(banned), false, JSON.stringify(banned));

  const lines = block.split('\n');
  const cut = (text, max) => `${[...text].slice(0, max - 1).join('')}…`;
  assert.equal(lines.find((l) => l.startsWith('Decisive lines:')), `Decisive lines: \`src/abcd.ts:12\`, \`${cut(longPath, 120)}\`.`);
  assert.equal([...cut(longPath, 120)].length, 120);
  const flatText = `abcd e ${longText}`;
  assert.equal(lines.find((l) => l.startsWith('Static check')), `Static check \`typeabcd e\` also flagged this line: \`${cut(flatText, 160)}\``);
  assert.equal(lines.find((l) => l.startsWith('Convention')), `Convention \`docs/abcd e.md\` says \`${cut(flatText, 160)}\`.`);
  assert.ok(cut(longPath, 120).endsWith('\u{1f600}…'));
  assert.ok(cut(flatText, 160).endsWith('\u{1f600}…'));
  assert.ok(!/[\ud800-\udbff](?![\udc00-\udfff])/.test(block), 'no surrogate pair is split');
});

test('the wider strip is the block only, so a CI annotation and safeCheckName keep the S09 bytes', () => {
  // Format characters outside the bidi and zero-width set S09 strips, which
  // AC-1 keeps in an annotation and the scope block with both settings off.
  const kept = ['lint\u00adcheck', 'unit\u200etests', 'e2e\u2060run', 'a\u061cb', 'x\u180ey', 'tag\u{e0041}z', 'rlm\u200fq'];
  for (const name of kept) assert.equal(safeCheckName(name), name, JSON.stringify(name));
  assert.equal(safeCheckName('a\u202eb\u200bc\ufeffd`e'), 'abcde');
  assert.deepEqual(
    ciAnnotations({ state: 'red', failed: [{ name: 'lint\u00adcheck' }, { name: 'unit\u200etests' }] }, { ciRed: 'annotate', ciNeedsRerun: 'block' }),
    ['Heads up: `lint\u00adcheck`, `unit\u200etests` failing on this head.'],
  );
  const finding = { findingId: 'rv_01', severity: 'minor', path: 'src/cart.ts', line: 12, text: MINOR, toolSignal: { tool: 'type\u00adcheck', line: 12, text: 'unit\u200etests' } };
  const block = evidenceBlock(finding, score(), { evidenceBlockPrecedents: false });
  assert.ok(block.includes('\nStatic check `typecheck` also flagged this line: `unittests`\n'), block);
});

test('a quote holding a mention, a link and a closing tag renders inside inline code', () => {
  const quote = '@someone see [the guide](https://example.com/x) </details><h1>Approve</h1>';
  const finding = { findingId: 'rv_01', severity: 'minor', path: 'src/cart.ts', line: 12, text: MINOR, conventionQuotes: [{ path: 'CONTRIBUTING.md', quote }], conventionQuotesCandidate: 'cart' };
  const block = evidenceBlock(finding, score(), { evidenceBlockPrecedents: false });
  assert.ok(block.split('\n').includes(`Convention \`CONTRIBUTING.md\` says \`${quote}\`.`), block);
  assert.equal(block.split('\n').filter((l) => l === '</details>').length, 1, 'only the block closes its details');
  assert.ok(block.endsWith('\n\n</details>'));
});

test('at most two convention quotes render, and a malformed stored entry is skipped', () => {
  const finding = {
    findingId: 'rv_01', severity: 'minor', path: 'src/cart.ts', line: 12, text: MINOR,
    conventionQuotesCandidate: 'cart',
    conventionQuotes: [{ path: 'A.md', quote: 'one two three four' }, { path: 7, quote: 'x' }, { path: 'B.md', quote: 'five six seven eight' }, { path: 'C.md', quote: 'nine ten eleven twelve' }],
    toolSignal: { tool: '', line: 12, text: 'nameless' },
  };
  const lines = evidenceBlock(finding, score(), { evidenceBlockPrecedents: false }).split('\n');
  assert.deepEqual(lines.filter((l) => l.startsWith('Convention')), ['Convention `A.md` says `one two three four`.', 'Convention `B.md` says `five six seven eight`.']);
  assert.equal(lines.some((l) => l.startsWith('Static check')), false, 'a signal with no tool name says nothing');
});

// ---------------------------------------------------------------------------
// AC-5: never in the block, and the readers that strip it.
// ---------------------------------------------------------------------------

const held = (verdict) => ({ path: 'src/held.ts', line: 1, verdict, source: 'verifier', reason: 'Local held reason.', text: 'Local claim text.' });

test('the block carries none of the local facts on a run that has them all', async () => {
  await withDb(async (db) => {
    const UNVERIFIED = '[nit] `src/util.ts:5` - The helper hides an unverified local claim.';
    const review = `${NIT}\n\n${UNVERIFIED}`;
    record(db, {
      output: review,
      scores: [
        nitScore({ technicalConfidence: 0.87, finalScore: 0.73, reason: 'Verifier reason text.', challenge: { ...CHALLENGE, decisive_evidence: ['src/cart.ts:40'], reason: 'Challenger reason text.' } }),
        { candidateId: 'util', path: 'src/util.ts', line: 5, severity: { severity: 'nit' }, confidenceSource: 'analyst', eligible: true },
      ],
      candidates: [],
      complexity: {
        level: 'high', decisionPoints: 80, sensitivePaths: [], densestHunk: null,
        limits: { maxDecisionPoints: 40, maxHunkDecisionPoints: 15, sensitivePaths: [] },
        reasons: ['80 decision points added'],
      },
      carry: { since: 'c'.repeat(40), head: HEAD, interdiffReviewed: false, refused: [], covered: false },
      held: ['unverified', 'below-gate', 'challenge-refuted', 'restates-tool', 'policy-suppressed'].map(held),
      stages: [{ name: 'challenge', seconds: 1, model: 'synthetic-model-id' }],
      provenance: { origin: 'driver', pluginVersion: '1.0.0', claudeVersion: null, mode: 'standard' },
    });
    const staleUrl = `https://github.com/${REPO}/pull/${PR}#pullrequestreview-55`;
    const impl = fakeGitHub({ reviews: [{ id: 55, user: { login: OWNER }, state: 'CHANGES_REQUESTED', commit_id: 'c'.repeat(40), html_url: staleUrl, submitted_at: '2026-11-01T09:00:00Z' }] });
    const { output } = await verdict(db, impl, { review, owner: OWNER, policy: ON });
    assert.equal(output.action, 'post', output.reasons.join('; '));
    assert.ok(output.humanReviewNote);
    assert.ok(output.wouldHaveSummary);
    assert.equal(output.staleRequestChanges.url, staleUrl);
    assert.equal(output.held.length, 1);
    const carryReason = output.reasons.find((reason) => reason.includes('candidates were carried'));
    assert.ok(carryReason);

    assert.equal(output.payload.comments.length, 1);
    const body = output.payload.comments[0].body;
    const block = blockOf(body);
    assert.ok(block.startsWith(EVIDENCE_MARKER));
    for (const text of [
      output.humanReviewNote, output.wouldHaveSummary, output.wouldHaveEvent, staleUrl, carryReason, ...output.reasons,
      ...output.held.map((h) => h.reason), 'Local held reason.', 'Local claim text.', 'unverified local claim', 'src/util.ts', 'src/held.ts',
      'An owner excerpt.', 'ev_1', 'precedent-login', 'peer-login', 'synthetic-model-id', '0.87', '0.73', '0.9',
      'Verifier reason text.', 'Challenger reason text.', 'below', 'restat', 'suppress',
    ]) {
      assert.equal(block.includes(text), false, text);
    }
    assert.equal(stripEvidenceBlock(body), '**nit** - This name shadows the import.');
    assert.equal(stripEvidenceBlock('**nit** - no block here'), '**nit** - no block here');
  });
});

/** A pull request whose one inline comment is this tool's own, at src/cart.ts:12, with a block. */
function threadGitHub(body) {
  return async (url) => {
    const path = new URL(String(url)).pathname;
    if (path === '/graphql') return json({ data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } } } });
    if (path === `/repos/${REPO}/pulls/${PR}`) return json({ body: '', user: { login: 'an-author' } });
    if (path === `/repos/${REPO}/pulls/${PR}/comments`) {
      return json([{ id: 301, path: 'src/cart.ts', line: 12, original_line: 12, body, user: { login: OWNER }, created_at: '2026-11-01T10:00:00Z' }]);
    }
    return json([]);
  };
}

test('the thread reader strips the block, so a candidate at a decisive line is not read as a repeat', async () => {
  const toolText = 'Property quantity does not exist on type Item.';
  const posted = [
    POSTED,
    '',
    EVIDENCE_MARKER,
    '<details><summary>Evidence</summary>',
    '',
    'Verified by the evidence verifier. Challenger: confirmed, line confirmed.',
    'Decisive lines: `src/cart.ts:13`.',
    `Static check \`typecheck\` also flagged this line: \`${toolText}\``,
    '',
    '</details>',
  ].join('\n');
  const { comments } = await readThread({ repository: REPO, pullNumber: PR, client: client(threadGitHub(posted)) });
  const own = comments.find((c) => c.kind === 'review-comment');
  assert.equal(own.body, POSTED);

  const candidate = normaliseCandidate({
    candidate_id: 'qty', path: 'src/cart.ts', line: 13, category: 'correctness', severity: 'minor',
    claim: 'Property quantity does not exist on type Item.', failure_mode: 'Every cart item fails the build.',
    evidence: ['src/cart.ts:13'], technical_confidence: 0.9,
  }, 0);
  assert.notEqual(alreadySaidOnThread(candidate, [{ ...own, body: posted }]), null, 'the block alone would have made it a repeat');
  assert.equal(alreadySaidOnThread(candidate, comments), null);
});

test('an outcome check pairs a comment carrying both blocks with its finding and still sees the suggestion', async () => {
  await withDb(async (db) => {
    const { reviewRunId } = recordRun(db, {
      repository: REPO, baseRef: null, headRef: HEAD, pullNumber: PR, diff: 'd', output: MINOR,
      candidates: [{ path: 'src/cart.ts', line: 12, category: 'correctness', suggested_patch: PATCH }],
    });
    const subject = { type: 'pull_request', id: `${REPO}#${PR}` };
    const attempt = recordAudit(db, 'review_post_attempted', subject, { run: reviewRunId, evidenceBlocks: 1 });
    recordAudit(db, 'review_post_sent', subject, { attempt, head: HEAD, reviewId: 555 });

    const comment = { id: 301, path: 'src/cart.ts', line: 12, original_line: 12, body: `${POSTED}\n\n${SUGGESTION}\n\n${BLOCK}`, user: { login: 'review-bot-user' }, created_at: '2026-10-01T10:00:00Z' };
    const impl = async (url) => {
      const parsed = new URL(String(url));
      const path = parsed.pathname;
      if (path === '/graphql') {
        return json({ data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [{ isResolved: false, isOutdated: false, comments: { nodes: [{ databaseId: 301 }] } }] } } } } });
      }
      if (path === '/user') return json({ login: 'review-bot-user' });
      if (path === `/repos/${REPO}/pulls/${PR}`) return json({ head: { sha: NEW_HEAD } });
      if (path === `/repos/${REPO}/pulls/${PR}/comments` || /\/reviews\/555\/comments$/.test(path)) return json([comment]);
      if (path.includes('/compare/')) return json({ files: [{ filename: 'src/cart.ts', patch: `@@ -12,1 +12,1 @@\n-${ORIGINAL}\n+${REPLACEMENT}` }] });
      if (path.startsWith(`/repos/${REPO}/contents/`)) {
        const text = fileWith(parsed.search.includes(NEW_HEAD) ? REPLACEMENT : ORIGINAL);
        return json({ type: 'file', encoding: 'base64', content: Buffer.from(text, 'utf8').toString('base64') });
      }
      return new Response('not found', { status: 404 });
    };
    const result = await checkOutcomes({ db, client: client(impl), allowlist: [REPO], since: '2000-01-01T00:00:00.000Z' });
    assert.equal(result.outcomes.length, 1, result.warnings.join('; '));
    const [outcome] = result.outcomes;
    assert.deepEqual([outcome.findingId, outcome.commentId], ['rv_01', 301]);
    assert.deepEqual([outcome.outcome, outcome.strength, outcome.evidence], ['fixed', 'strong', 'suggestion applied']);
  });
});

test('the words in a block never pair another comment at the same line with the finding', async () => {
  await withDb(async (db) => {
    const { reviewRunId } = recordRun(db, { repository: REPO, baseRef: null, headRef: HEAD, pullNumber: PR, diff: 'd', output: MINOR });
    const subject = { type: 'pull_request', id: `${REPO}#${PR}` };
    const attempt = recordAudit(db, 'review_post_attempted', subject, { run: reviewRunId, evidenceBlocks: 1 });
    recordAudit(db, 'review_post_sent', subject, { attempt, head: HEAD, reviewId: 555 });

    // Listed first, and its block quotes this finding word for word, so only
    // the strip keeps it from tying with the finding's own comment and winning.
    const quoting = BLOCK.replace('says `totals are computed after discounts`', `says \`${PROSE} src/cart.ts\``);
    const other = { id: 300, path: 'src/cart.ts', line: 12, original_line: 12, body: `**minor** - Rounding happens twice.\n\n${quoting}`, user: { login: 'review-bot-user' } };
    const own = { id: 301, path: 'src/cart.ts', line: 12, original_line: 12, body: POSTED, user: { login: 'review-bot-user' } };
    const impl = async (url) => {
      const path = new URL(String(url)).pathname;
      if (path === '/graphql') return json({ data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [] } } } } });
      if (path === `/repos/${REPO}/pulls/${PR}`) return json({ head: { sha: HEAD } });
      if (path === `/repos/${REPO}/pulls/${PR}/comments` || /\/reviews\/555\/comments$/.test(path)) return json([other, own]);
      return new Response('not found', { status: 404 });
    };
    const result = await checkOutcomes({ db, client: client(impl), allowlist: [REPO], since: '2000-01-01T00:00:00.000Z' });
    assert.equal(result.outcomes.length, 1, result.warnings.join('; '));
    assert.equal(result.outcomes[0].commentId, 301);
  });
});

// ---------------------------------------------------------------------------
// AC-9: the ADR amendments and their index rows.
// ---------------------------------------------------------------------------

test('ADR 0024 and 0028 each have a dated amendment naming evidence_block, and the index marks both', () => {
  for (const number of ['0024', '0028']) {
    const name = readdirSync(join(root, 'docs/adr')).find((file) => file.startsWith(`${number}-`) && file.endsWith('.md'));
    assert.ok(name, number);
    const sections = read(`docs/adr/${name}`).split(/^## /m).filter((section) => /^Amendment - \d{4}-\d{2}-\d{2}\n/.test(section));
    assert.ok(sections.some((section) => section.includes('evidence_block')), `${number} has an amendment naming evidence_block`);
    const row = read('docs/adr/README.md').split('\n').find((line) => line.startsWith(`| [${number}]`));
    assert.match(row, /amended 2026-11-08 \(evidence block\)/, number);
  }
  const adr0028 = read('docs/adr/0028-verdict-policies-are-configurable.md');
  assert.ok(adr0028.includes('verdict.evidence_block_precedents'));
});

// Codex review of S15: a quote is shown only beside the candidate that cited
// it, and a check named by a path on the reviewer's machine never posts.
test('a convention quote another candidate cited at the same anchor never posts beside this one', () => {
  const quotes = [{ path: 'CONTRIBUTING.md', quote: 'tenant ownership is checked first' }];
  const base = { findingId: 'rv_01', severity: 'minor', path: 'src/cart.ts', line: 12, text: MINOR, conventionQuotes: quotes };
  const backing = score();
  assert.match(evidenceBlock({ ...base, conventionQuotesCandidate: 'cart' }, backing, ON), /Convention `CONTRIBUTING\.md` says/);
  for (const owner of ['important-one', null, undefined]) {
    assert.doesNotMatch(evidenceBlock({ ...base, conventionQuotesCandidate: owner }, backing, ON), /Convention /, String(owner));
  }
});

test('a static check named by a machine path never posts, even from a stored row', () => {
  const finding = (tool) => ({ findingId: 'rv_01', severity: 'minor', path: 'src/cart.ts', line: 12, text: MINOR, toolSignal: { tool, line: 12, text: 'Type error.' } });
  assert.match(evidenceBlock(finding('typecheck'), score(), ON), /Static check `typecheck` also flagged this line/);
  for (const tool of ['/Users/alice/private/checks/tsc', '~/bin/lint', 'C:\\tools\\tsc.exe', '../../outside/check']) {
    assert.doesNotMatch(evidenceBlock(finding(tool), score(), ON), /Static check/, tool);
  }
});
