import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../plugins/review-voice/src/store/db.ts';
import { HELD_VERDICTS, recordedChecks, recordRun, runDetail } from '../plugins/review-voice/src/store/runs.ts';
import { GitHubClient } from '../plugins/review-voice/src/github/client.ts';
import { ReviewWriter } from '../plugins/review-voice/src/github/writer.ts';
import { loadConfig } from '../plugins/review-voice/src/policy/load.ts';
import { computeVerdict, postReview } from '../plugins/review-voice/src/publish/post.ts';
import { safeCheckName, scopeBlock, replaceAnnotations } from '../plugins/review-voice/src/publish/verdict.ts';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const HEAD = 'a1b2c3d' + 'e'.repeat(33);
const REPO = 'acme/web';
const PR = 7;
const OWNER = 'your-github-login';
const CLEAN = 'No actionable findings.';
const MINOR = '[minor] `src/cart.ts:12` - The total skips the discount. A discounted cart is overcharged.';
const SCORES = [{ candidateId: 'cart', path: 'src/cart.ts', line: 12, severity: { severity: 'minor' }, confidenceSource: 'verifier', eligible: true }];
const PROVENANCE = { origin: 'driver', pluginVersion: '1.0.0', claudeVersion: null, mode: 'standard' };
const SCOPE = { kind: 'full', cause: 'requested', since: null, priorRunId: null };
const STAGES = ['intent', 'analyst', 'verifier', 'challenge', 'editor'].map((name) => ({ name, seconds: 1, model: 'synthetic-model' }));
const CHECKS = {
  staticRan: [{ name: 'typecheck', exitCode: 0, signals: 0 }],
  staticDidNotRun: [{ name: 'lint', reason: 'REVIEW_VOICE_NO_COMMANDS' }],
  symbolsInconclusive: 2,
  symbolsBudgetExhausted: true,
};
const held = (verdict) => ({ path: 'src/held.ts', line: 1, verdict, source: 'verifier', reason: 'Local held reason.', text: 'Local claim text.' });
const HELD = ['unverified', 'below-gate', 'below-gate', 'challenge-refuted', 'restates-tool', 'policy-suppressed'].map(held);
const ZERO_HELD = { unverified: 0, belowGate: 0, challenge: 0, restatesTool: 0, policySuppressed: 0, other: 0 };
const ZERO_FINDINGS = { blocking: 0, important: 0, minor: 0, nit: 0, question: 0 };
const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const check = (name, conclusion) => ({ id: 1, name, status: 'completed', conclusion, completed_at: '2026-11-01T10:00:00Z' });
const GREEN = [check('build', 'success')];
const RED = [check('build', 'failure')];
const RERUN = [check('e2e', 'timed_out')];

function fixture(t) {
  const data = mkdtempSync(join(tmpdir(), 'rv-scope-block-'));
  const previous = process.env.REVIEW_VOICE_DATA_DIR;
  process.env.REVIEW_VOICE_DATA_DIR = data;
  const db = openDatabase(join(data, 'review-voice.db'));
  t.after(() => {
    db.close();
    if (previous === undefined) delete process.env.REVIEW_VOICE_DATA_DIR;
    else process.env.REVIEW_VOICE_DATA_DIR = previous;
    rmSync(data, { recursive: true, force: true });
  });
  return { db, data };
}

function record(db, extra = {}) {
  return recordRun(db, {
    repository: REPO, baseRef: null, headRef: HEAD, pullNumber: PR, diff: 'diff', output: CLEAN,
    scope: SCOPE, provenance: PROVENANCE, stages: STAGES, checks: CHECKS, ...extra,
  });
}

// CI answers are sequential so the send can observe a different state from its preview.
function fakeGitHub({ checks = [GREEN], reviews = [] } = {}) {
  let reads = 0;
  const posts = [];
  const impl = async (url, init = {}) => {
    const path = new URL(String(url)).pathname;
    if (init.method === 'POST') {
      assert.equal(path, '/repos/' + REPO + '/pulls/' + PR + '/reviews');
      posts.push(JSON.parse(init.body));
      return json({ id: 101, html_url: 'https://github.com/' + REPO + '/pull/' + PR + '#pullrequestreview-101', state: posts.at(-1).event });
    }
    if (/\/pulls\/\d+$/.test(path)) return json({ head: { sha: HEAD } });
    if (path.endsWith('/reviews')) return json(reviews);
    if (path.endsWith('/check-runs')) {
      const runs = checks[Math.min(reads++, checks.length - 1)];
      return json({ total_count: runs.length, check_runs: runs });
    }
    if (path.endsWith('/status')) return json({ state: 'success', total_count: 0, statuses: [] });
    throw new Error('Unexpected GitHub request: ' + path);
  };
  impl.posts = posts;
  return impl;
}

function options(db, impl, extra = {}) {
  return {
    db, client: new GitHubClient({ allowlist: [REPO], token: 't', fetchImpl: impl, sleep: async () => {} }),
    repository: REPO, pullNumber: PR, head: HEAD, review: CLEAN, owner: OWNER, ...extra,
  };
}

function post(db, impl, extra = {}) {
  return postReview({
    ...options(db, impl),
    writerFor: (allowlist) => new ReviewWriter({ allowlist, token: 't', fetchImpl: impl }),
    confirm: true, event: 'APPROVE', postingEnabled: true, ...extra,
  });
}

function trailer(block) {
  const match = block.match(/\n<!-- review-voice (\{[^\n]*\}) -->$/);
  assert.ok(match, 'The last line is the JSON comment.');
  return JSON.parse(match[1]);
}

test('AC-2: disabling the block preserves the original body bytes through post', async (t) => {
  const { db } = fixture(t);
  record(db, { output: MINOR, scores: SCORES, held: HELD });
  const original = await computeVerdict(options(db, fakeGitHub(), { review: MINOR }));
  const impl = fakeGitHub();
  const sent = await post(db, impl, { review: MINOR, event: 'COMMENT', policy: { scopeBlock: false, scopeBlockModels: true } });
  assert.equal(sent.exitCode, 0, JSON.stringify(sent.output));
  assert.equal(sent.output.status, 'sent');
  assert.deepEqual(impl.posts, [{
    commit_id: HEAD,
    event: 'COMMENT',
    body: '1 comment, the highest minor.',
    comments: [{ path: 'src/cart.ts', line: 12, side: 'RIGHT', body: '**minor** - The total skips the discount. A discounted cart is overcharged.' }],
  }]);
  assert.deepEqual(impl.posts[0], original.output.payload);
  assert.equal(sent.output.key, original.output.key);
});

test('AC-3: the recorded scope has the specified shape and is shared by preview and post', async (t) => {
  const { db } = fixture(t);
  const id = record(db, { output: MINOR, scores: SCORES, held: HELD }).reviewRunId;
  const policy = { scopeBlock: true, scopeBlockModels: false };
  const verdict = await computeVerdict(options(db, fakeGitHub(), { review: MINOR, policy, runId: id }));
  assert.equal(verdict.exitCode, 0);
  const facts = {
    head: HEAD, origin: 'driver', independence: 'independent',
    findings: { ...ZERO_FINDINGS, minor: 1 },
    held: { unverified: 1, belowGate: 2, challenge: 1, restatesTool: 1, policySuppressed: 1, other: 0 },
    checks: { ran: 1, didNotRun: 1 }, issues: null,
  };
  const expected = [
    '<details><summary>Review scope</summary>',
    '',
    'Head `a1b2c3d`, full scope, standard mode. Origin: driver (independent).',
    'Stages: `intent`, `analyst`, `verifier`, `challenge`, `editor`.',
    'Static checks: `typecheck` ran (exit 0, 0 signals); `lint` did not run (`REVIEW_VOICE_NO_COMMANDS`).',
    'Symbol context: 2 files not finished (time budget).',
    'Not posted: 1 unverified claim, 2 below the gate, 1 held by the challenger, 1 restating a static check, 1 suppressed by policy.',
    'Not checked: UI behaviour, product policy, load behaviour, files the symbol search did not finish.',
    '',
    '</details>',
    '<!-- review-voice ' + JSON.stringify(facts) + ' -->',
  ].join('\n');
  const detail = runDetail(db, id);
  assert.equal(scopeBlock(detail, verdict.planned, policy), expected);
  assert.equal(scopeBlock(detail, verdict.planned, policy), expected);
  assert.deepEqual(trailer(expected), facts);
  assert.equal(verdict.output.payload.body, '1 comment, the highest minor.\n\n' + expected);
  assert.ok(verdict.output.preview.includes('Body: ' + verdict.output.payload.body + '\nComments:'));
  // A newer run must not replace the explicitly selected record's scope or checks.
  record(db, { provenance: { ...PROVENANCE, mode: 'fast' }, checks: undefined });
  const impl = fakeGitHub();
  const sent = await post(db, impl, { review: MINOR, event: 'COMMENT', policy, runId: id });
  assert.equal(sent.exitCode, 0, JSON.stringify(sent.output));
  assert.equal(sent.output.status, 'sent');
  assert.deepEqual(impl.posts, [verdict.output.payload]);
  assert.equal(sent.output.verdict.preview, verdict.output.preview);
});

test('AC-3: missing provenance, checks, scope and stages are explicitly not recorded', async (t) => {
  const { db } = fixture(t);
  record(db, { provenance: undefined, checks: undefined, scope: undefined, stages: undefined });
  const { output } = await computeVerdict(options(db, fakeGitHub(), { policy: { scopeBlock: true } }));
  const body = output.payload.body;
  assert.match(body, /Head `a1b2c3d`, scope not recorded, mode not recorded\. Origin: not recorded\./);
  assert.match(body, /^Stages: not recorded\.$/m);
  assert.match(body, /^Static checks: not recorded\.$/m);
  assert.match(body, /^Symbol context: not recorded\.$/m);
  assert.deepEqual(trailer(body), { head: HEAD, origin: null, independence: null, findings: ZERO_FINDINGS, held: ZERO_HELD, checks: null, issues: null });
});

test('AC-3: failed checks and completed symbol context describe what ran', async (t) => {
  const { db } = fixture(t);
  record(db, { checks: {
    staticRan: [{ name: 'lint', exitCode: 1, signals: 2 }], staticDidNotRun: [],
    symbolsInconclusive: 0, symbolsBudgetExhausted: false,
  } });
  const { output } = await computeVerdict(options(db, fakeGitHub(), { policy: { scopeBlock: true } }));
  assert.match(output.payload.body, /^Static checks: `lint` ran \(exit 1, 2 signals\)\.$/m);
  assert.match(output.payload.body, /^Symbol context: every changed file finished\.$/m);
  assert.match(output.payload.body, /^Not checked: UI behaviour, product policy, load behaviour\.$/m);
});

test('AC-4: toggling the block keeps the key and a CI annotation swap preserves it', async (t) => {
  const { db } = fixture(t);
  record(db);
  const policy = { scopeBlock: true, ciRed: 'annotate', ciNeedsRerun: 'annotate' };
  const before = await computeVerdict(options(db, fakeGitHub({ checks: [RED] }), { policy }));
  const off = await computeVerdict(options(db, fakeGitHub({ checks: [RED] }), { policy: { ...policy, scopeBlock: false } }));
  assert.equal(before.output.key, off.output.key);
  const block = scopeBlock(before.run, before.planned, policy);
  assert.equal(before.output.payload.body, 'No problems found.\n\n' + block + '\n\nHeads up: `build` failing on this head.');
  const impl = fakeGitHub({ checks: [RED, RERUN] });
  const sent = await post(db, impl, { policy });
  assert.equal(sent.exitCode, 0, JSON.stringify(sent.output));
  assert.equal(sent.output.key, off.output.key);
  assert.equal(impl.posts.length, 1);
  assert.equal(impl.posts[0].body, 'No problems found.\n\n' + block + '\n\nHeads up: `e2e` need a rerun.');
  assert.doesNotMatch(impl.posts[0].body, /failing on this head/);
  assert.ok(sent.output.verdict.preview.includes(impl.posts[0].body));
  const next = ['Heads up: `e2e` need a rerun.'];
  assert.equal(replaceAnnotations(impl.posts[0].body, next, []), 'No problems found.\n\n' + block);
  const interior = 'Heads up: `build` failing on this head.\n\n' + block;
  assert.equal(replaceAnnotations(interior, before.output.annotations, []), interior);
});

test('AC-5: complexity, would-have verdict, stale request and uncovered carry all stay local', async (t) => {
  const { db } = fixture(t);
  record(db, {
    complexity: {
      level: 'high', decisionPoints: 80, sensitivePaths: [], densestHunk: null,
      limits: { maxDecisionPoints: 40, maxHunkDecisionPoints: 15, sensitivePaths: [] },
      reasons: ['80 decision points added'],
    },
    carry: { since: 'b'.repeat(40), head: HEAD, interdiffReviewed: false, refused: [], covered: false },
    held: HELD,
  });
  const staleUrl = 'https://github.com/' + REPO + '/pull/' + PR + '#pullrequestreview-55';
  const impl = fakeGitHub({ reviews: [{
    id: 55, user: { login: OWNER }, state: 'CHANGES_REQUESTED', commit_id: 'b'.repeat(40),
    html_url: staleUrl, submitted_at: '2026-11-01T09:00:00Z',
  }] });
  const { output } = await computeVerdict(options(db, impl, { policy: { scopeBlock: true } }));
  assert.equal(output.complexity.level, 'high');
  assert.ok(output.humanReviewNote);
  assert.equal(output.wouldHaveEvent, 'APPROVE');
  assert.equal(output.wouldHaveSummary, 'Would have approved: no problems found.');
  assert.equal(output.staleRequestChanges.url, staleUrl);
  const carryReason = output.reasons.find((reason) => reason.includes('candidates were carried'));
  assert.ok(carryReason);
  for (const text of [
    output.humanReviewNote, output.wouldHaveEvent, output.wouldHaveSummary, staleUrl, carryReason,
    'humanReviewNote', 'wouldHaveEvent', 'wouldHaveSummary', 'staleRequestChanges', 'Local held reason.', 'Local claim text.',
    ...output.reasons,
  ]) {
    assert.equal(output.payload.body.includes(text), false, text);
  }
});

test('AC-6: models are opt-in and configured check and recorded stage names use safeCheckName', async (t) => {
  const { db, data } = fixture(t);
  const hostile = 'li`nt\u202e\u200b\ncheck';
  const long = 'w'.repeat(58) + '\u{1f600}' + 'z'.repeat(31);
  assert.equal([...long].length, 90);
  mkdirSync(join(data, '.review-voice'));
  writeFileSync(join(data, '.review-voice/config.yaml'), JSON.stringify({
    verdict: { scope_block: true },
    static_evidence: { enabled: true, commands: [hostile, long].map((name) => ({ name, run: 'node --version' })) },
  }));
  const config = loadConfig(data);
  assert.deepEqual(config.warnings, []);
  const checks = recordedChecks({
    commands: config.staticEvidence.commands.map(({ name }) => ({ name, exitCode: 0, signals: [] })),
    didNotRun: [long], skipped: 'disabled',
  }, { files: [], budget: { exhausted: false } });
  record(db, { checks, stages: [{ name: hostile, seconds: 1, model: 'model`\u202e\u200b-one', models: [long, 'model-two'] }] });
  const hidden = await computeVerdict(options(db, fakeGitHub(), { policy: config.verdictPolicy }));
  const shown = await computeVerdict(options(db, fakeGitHub(), { policy: { ...config.verdictPolicy, scopeBlockModels: true } }));
  assert.equal(safeCheckName(hostile), 'lint check');
  assert.equal(safeCheckName(long), 'w'.repeat(58) + '\u{1f600}…');
  assert.match(hidden.output.payload.body, /^Stages: `lint check`\.$/m);
  assert.doesNotMatch(hidden.output.payload.body, /model-one|model-two/);
  assert.ok(shown.output.payload.body.includes('Stages: `lint check` (`' + safeCheckName(long) + '`, `model-two`, `model-one`).'));
  for (const result of [hidden, shown]) {
    const body = result.output.payload.body;
    assert.ok(body.includes('Static checks: `' + safeCheckName(hostile) + '` ran (exit 0, 0 signals); `' + safeCheckName(long) + '` did not run (`disabled`).'));
    assert.doesNotMatch(body, /[\u202e\u200b]/);
    assert.equal(body.includes(hostile), false);
    assert.equal(body.includes(long), false);
    assert.ok(body.isWellFormed());
  }
});

test('AC-7: JSON has all keys, the full head and every held verdict, including future values', async (t) => {
  const { db } = fixture(t);
  record(db, { held: [...HELD_VERDICTS, 'future-verdict'].map(held) });
  const result = await computeVerdict(options(db, fakeGitHub(), { policy: { scopeBlock: true } }));
  const mapping = {
    unverified: 'unverified', 'below-gate': 'belowGate', 'challenge-refuted': 'challenge', 'challenge-partly': 'challenge',
    'restates-tool': 'restatesTool', 'policy-suppressed': 'policySuppressed',
  };
  const expected = { ...ZERO_HELD };
  for (const verdict of [...HELD_VERDICTS, 'future-verdict']) {
    const category = mapping[verdict] ?? 'other';
    expected[category] += 1;
    const block = scopeBlock({ ...result.run, held: [held(verdict)] }, result.planned, { scopeBlockModels: false });
    assert.deepEqual(trailer(block).held, { ...ZERO_HELD, [category]: 1 }, verdict);
  }
  const facts = trailer(result.output.payload.body);
  assert.deepEqual(facts, {
    head: HEAD, origin: 'driver', independence: 'independent', findings: ZERO_FINDINGS, held: expected, checks: { ran: 1, didNotRun: 1 }, issues: null,
  });
  assert.equal(Object.values(facts.held).reduce((sum, count) => sum + count, 0), HELD_VERDICTS.length + 1);
  assert.doesNotMatch(result.output.payload.body, /0 unverified|0 below|0 held|0 restating|0 suppressed/);
});

test('AC-7: JSON counts inline and unanchored findings at every severity', async (t) => {
  const { db } = fixture(t);
  const findings = ['blocking', 'important', 'minor', 'nit', 'question'].map((severity, index) => ({
    severity, path: 'src/cart.ts', line: index + 1,
  }));
  record(db);
  const result = await computeVerdict(options(db, fakeGitHub(), { policy: { scopeBlock: true } }));
  const block = scopeBlock(result.run, {
    ...result.planned, inline: findings.slice(0, 3), unanchored: [...findings.slice(3), findings[2]],
  }, { scopeBlockModels: false });
  assert.deepEqual(trailer(block).findings, { blocking: 1, important: 1, minor: 2, nit: 1, question: 1 });
});

// S19 AC-7: the issues the thread read for intent are named, as inline code, and
// carried in the trailer; a run that recorded no checks, or checks from before
// the thread said, carries null rather than a zero.
test('S19 AC-7: linked issues read for intent appear in the block and the trailer, or as null when not recorded', async (t) => {
  const { db } = fixture(t);
  const policy = { scopeBlock: true };
  const one = record(db, { checks: { ...CHECKS, issuesRead: [12] } }).reviewRunId;
  const none = record(db, { checks: { ...CHECKS, issuesRead: [] } }).reviewRunId;
  const withIssue = await computeVerdict(options(db, fakeGitHub(), { policy, runId: one }));
  const withoutIssue = await computeVerdict(options(db, fakeGitHub(), { policy, runId: none }));
  assert.match(withIssue.output.payload.body, /^Symbol context: .*\nLinked issues: `#12` read for intent\.\nNot posted: /m);
  assert.deepEqual(trailer(withIssue.output.payload.body).issues, [12]);
  assert.doesNotMatch(withoutIssue.output.payload.body, /Linked issues/);
  assert.deepEqual(trailer(withoutIssue.output.payload.body).issues, []);
  assert.equal(withIssue.output.key, withoutIssue.output.key, 'the idempotency key ignores the block');
  // An S09-era row has checks without issuesRead, and a row without checks has none: neither claims it read no issues.
  const older = record(db, { checks: CHECKS }).reviewRunId;
  assert.equal(runDetail(db, older).checks.issuesRead, undefined);
  assert.equal(trailer((await computeVerdict(options(db, fakeGitHub(), { policy, runId: older }))).output.payload.body).issues, null);
  const unrecorded = record(db, { checks: undefined }).reviewRunId;
  const bare = await computeVerdict(options(db, fakeGitHub(), { policy, runId: unrecorded }));
  assert.equal(trailer(bare.output.payload.body).issues, null);
  assert.equal(bare.output.key, withIssue.output.key);
});

test('AC-8: the ADR amendment, record command and posting documents describe the block', () => {
  const read = (path) => readFileSync(join(root, path), 'utf8');
  const adr = readdirSync(join(root, 'docs/adr')).find((name) => /^0028-.*\.md$/.test(name));
  assert.ok(adr);
  const amendment = read('docs/adr/' + adr).split('## Amendment - 2026-11-08\n')[1];
  assert.ok(amendment);
  for (const key of ['verdict.scope_block', 'verdict.scope_block_models']) assert.ok(amendment.includes(key));
  assert.match(amendment, /0016[\s\S]*lists stay local; only their counts post/);
  assert.match(read('docs/adr/README.md'), /\| \[0028\][^\n]*amended 2026-11-08 \(scope block\)/);
  assert.match(read('plugins/review-voice/commands/review.md'), /`RV record --repository <owner\/repo> --base[\s\S]*?--evidence <tmpdir>\/evidence\.json --symbols <tmpdir>\/symbols\.json[\s\S]*?`/);
  const template = read('plugins/review-voice/templates/config.example.yaml').split('\nverdict:\n')[1].split('\nstatic_evidence:')[0];
  assert.match(template, /  scope_block: false/);
  assert.match(template, /  scope_block_models: false/);
  const posting = read('docs/ARCHITECTURE.md').split('### Posting\n')[1].split('\n### ')[0];
  for (const text of [posting, read('plugins/review-voice/commands/draft-review.md'), read('plugins/review-voice/src/help.ts')]) {
    assert.ok(text.includes('scope_block'));
    assert.ok(text.includes('scope_block_models'));
    assert.match(text, /JSON/);
  }
});

// A name is rendered as inline code, so a check named to close the block and
// open markup renders as text inside the block instead.
test('a check named to escape the block cannot', async (t) => {
  const { db } = fixture(t);
  const hostile = '</details><h1>APPROVED</h1><details>';
  record(db, {
    checks: { staticRan: [{ name: hostile, exitCode: 0, signals: 0 }], staticDidNotRun: [{ name: 'lint', reason: `<!-- --> ${hostile}` }], symbolsInconclusive: 0, symbolsBudgetExhausted: false },
    stages: [{ name: hostile, seconds: 1 }],
  });
  const { output } = await computeVerdict(options(db, fakeGitHub(), { policy: { scopeBlock: true } }));
  const body = output.payload.body;
  assert.ok(body.includes('Stages: `' + hostile + '`.'));
  assert.ok(body.includes('Static checks: `' + hostile + '` ran (exit 0, 0 signals); `lint` did not run (`<!-- --> ' + hostile + '`).'));
  // Every occurrence of the closing tag is one of the three names, each inside a code span, plus the block's own.
  const closers = body.split('</details>').length - 1;
  const named = body.split(hostile).length - 1;
  assert.equal(named, 3);
  assert.equal(closers, named + 1);
  assert.equal(body.trimEnd().endsWith(' -->'), true, 'the trailer comment is still the last thing in the body');
  // Counted by plain splits: a browser also ends a comment at `--!>`, so that form must not appear at all.
  assert.equal(body.split('-->').length - 1, 2, 'the reason text and the trailer each close a comment exactly once, both inside their own span');
  assert.equal(body.includes('--!>'), false, 'no other comment ending appears');
});

// A recorded finding the posting step withholds (here, one with no score) was
// not posted either, so the block must count it rather than say nothing was held.
test('a finding withheld at posting is counted among the held claims', async (t) => {
  const { db } = fixture(t);
  const important = '[important] `src/cart.ts:12` - The total skips the discount. A discounted cart is overcharged. Apply it.';
  record(db, { output: important, scores: [], held: [] });
  const verdict = await computeVerdict(options(db, fakeGitHub(), { review: important, policy: { scopeBlock: true } }));
  assert.equal(verdict.exitCode, 0);
  assert.equal(verdict.planned.held.length, 1, 'the finding was withheld for want of a score');
  const body = verdict.output.payload.body;
  assert.match(body, /^Not posted: 1 held for other reasons\.$/m);
  assert.equal(trailer(body).held.other, 1);
  assert.deepEqual(trailer(body).findings, ZERO_FINDINGS);
});

// ---------------------------------------------------------------- S17 part B: the challenge family, with the models only

const MODELS = { scopeBlock: true, scopeBlockModels: true };
const challengedOn = (family) => STAGES.map((stage) => (stage.name === 'challenge' ? { ...stage, family } : stage));

test('S17 AC-12: a codex challenge ends the origin sentence and adds families as the last trailer key', async (t) => {
  const { db } = fixture(t);
  const id = record(db, { stages: challengedOn('codex') }).reviewRunId;
  const { output } = await computeVerdict(options(db, fakeGitHub(), { policy: MODELS, runId: id }));
  const body = output.payload.body;
  assert.match(body, /^Head `a1b2c3d`, full scope, standard mode\. Origin: driver \(independent\)\. Challenge: codex\.$/m);
  const facts = trailer(body);
  assert.deepEqual(facts.families, { secondPass: null, challenge: 'codex' });
  assert.equal(Object.keys(facts).at(-1), 'families');
});

test('S17 AC-12: without scope_block_models the family is neither in the prose nor in the trailer', async (t) => {
  const { db } = fixture(t);
  const id = record(db, { stages: challengedOn('codex') }).reviewRunId;
  const { output } = await computeVerdict(options(db, fakeGitHub(), { policy: { scopeBlock: true, scopeBlockModels: false }, runId: id }));
  assert.doesNotMatch(output.payload.body, /Challenge:/);
  assert.equal('families' in trailer(output.payload.body), false);
});

test('S17 AC-12: a claude challenge with no second-pass family, or no recorded families, adds nothing', async (t) => {
  const { db } = fixture(t);
  const claude = record(db).reviewRunId;
  const without = record(db, { provenance: undefined }).reviewRunId;
  // A row recorded before families were stored.
  const older = record(db, { stages: challengedOn('codex') }).reviewRunId;
  const stored = JSON.parse(db.prepare('SELECT provenance_json FROM review_runs WHERE review_run_id = ?').get(older).provenance_json);
  delete stored.families;
  db.prepare('UPDATE review_runs SET provenance_json = ? WHERE review_run_id = ?').run(JSON.stringify(stored), older);
  for (const id of [claude, without, older]) {
    const { output } = await computeVerdict(options(db, fakeGitHub(), { policy: MODELS, runId: id }));
    assert.doesNotMatch(output.payload.body, /Challenge:/, id);
    assert.equal('families' in trailer(output.payload.body), false, id);
  }
  assert.equal(runDetail(db, older).families, null);
});

test('S17 AC-12: a second pass with a family puts families in the trailer while the prose names no challenge family', async (t) => {
  const { db } = fixture(t);
  const verdicts = [{ candidateId: 'cart', path: 'src/cart.ts', line: 12, verdict: 'confirmed', confidence: 0.9, reason: 'Holds.', outcome: 'kept', originalSeverity: 'minor', finalSeverity: 'minor', verifier: 'codex', family: 'codex' }];
  const id = record(db, { verdicts }).reviewRunId;
  const { output } = await computeVerdict(options(db, fakeGitHub(), { policy: MODELS, runId: id }));
  assert.doesNotMatch(output.payload.body, /Challenge:/);
  assert.deepEqual(trailer(output.payload.body).families, { secondPass: 'codex', challenge: 'claude' });
});

test('S17: a finding held because its challenger did not run keeps the review from approving; no other hold does', async (t) => {
  const { db } = fixture(t);
  const notRun = { ...held('challenge-partly'), source: 'challenge', severity: 'minor', reason: 'challenger not run: runners.codex is not configured' };
  const capped = record(db, { held: [notRun] }).reviewRunId;
  const other = record(db, { held: [{ ...notRun, reason: 'challenger failed: the call failed: boom' }, held('challenge-refuted')] }).reviewRunId;
  const cappedVerdict = await computeVerdict(options(db, fakeGitHub(), { runId: capped }));
  assert.equal(cappedVerdict.planned.heldBackApproval, true);
  assert.equal(cappedVerdict.planned.mapped, 'COMMENT');
  const otherVerdict = await computeVerdict(options(db, fakeGitHub(), { runId: other }));
  assert.equal(otherVerdict.planned.heldBackApproval, false);
  assert.equal(otherVerdict.planned.mapped, 'APPROVE');
});
