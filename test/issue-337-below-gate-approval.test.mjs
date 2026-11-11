/**
 * Issue 337: a finding the verifier confirmed whose confidence fell under the
 * confidence gate is held as `below-gate` and never reaches the review text.
 * Above a nit it now counts against an approval as an unverified finding does
 * (docs/adr/0016, amended), and a narrowed review inherits the hold the way it
 * inherits one for a challenger that did not run. A hold by the final-score
 * gate never counts: that score carries the owner's precedent.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { assessComplexity } from '../plugins/review-voice/src/diff/complexity.ts';
import { openDatabase } from '../plugins/review-voice/src/store/db.ts';
import { heldBelowConfidenceGate, recordRun, runDetail } from '../plugins/review-voice/src/store/runs.ts';
import { GitHubClient } from '../plugins/review-voice/src/github/client.ts';
import { computeVerdict } from '../plugins/review-voice/src/publish/post.ts';
import { planFindings } from '../plugins/review-voice/src/publish/verdict.ts';
import { COMMAND_HELP } from '../plugins/review-voice/src/help.ts';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bundle = join(root, 'plugins/review-voice/dist/review-voice.mjs');

const HEAD = 'a1b2c3d' + 'e'.repeat(33);
const REPO = 'acme/web';
const PR = 7;
const PROVENANCE = { origin: 'driver', pluginVersion: '1.0.0', claudeVersion: null, mode: 'standard' };
const NO_FINDINGS = 'No actionable findings.';
const CONFIDENCE = 'below the confidence gate';
const SCORE = 'below the score gate';
const CLAIM = 'The export endpoint returns another tenant when the id is guessed.';
/** A line no hash or count in a posted body would spell by chance. */
const LINE = 4127;
const below = (severity, over = {}) => ({
  path: 'src/export.ts', line: LINE, verdict: 'below-gate', source: 'score', reason: CONFIDENCE, severity, candidateId: 'cand_001', text: CLAIM, ...over,
});
const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const GREEN = [{ id: 1, name: 'build', status: 'completed', conclusion: 'success', completed_at: '2026-11-01T10:00:00Z' }];
const capReason = (reasons) => reasons.filter((reason) => reason.includes('held back'));

function fixture(t) {
  const data = mkdtempSync(join(tmpdir(), 'rv-337-'));
  const previous = process.env.REVIEW_VOICE_DATA_DIR;
  process.env.REVIEW_VOICE_DATA_DIR = data;
  const db = openDatabase(join(data, 'review-voice.db'));
  t.after(() => {
    db.close();
    if (previous === undefined) delete process.env.REVIEW_VOICE_DATA_DIR;
    else process.env.REVIEW_VOICE_DATA_DIR = previous;
    rmSync(data, { recursive: true, force: true });
  });
  return db;
}

const record = (db, held, extra = {}) =>
  recordRun(db, { repository: REPO, baseRef: null, headRef: HEAD, pullNumber: PR, diff: 'diff', output: NO_FINDINGS, scores: [], held, provenance: PROVENANCE, ...extra });

function verdict(db, review = NO_FINDINGS, policy = {}) {
  const fetchImpl = async (url) => {
    const path = new URL(String(url)).pathname;
    if (/\/pulls\/\d+$/.test(path)) return json({ head: { sha: HEAD } });
    if (path.endsWith('/check-runs')) return json({ total_count: GREEN.length, check_runs: GREEN });
    if (path.endsWith('/status')) return json({ state: 'success', total_count: 0, statuses: [] });
    if (path.endsWith('/reviews')) return json([]);
    throw new Error('Unexpected GitHub request: ' + path);
  };
  return computeVerdict({
    db, client: new GitHubClient({ allowlist: [REPO], token: 't', fetchImpl, sleep: async () => {} }),
    repository: REPO, pullNumber: PR, head: HEAD, review, policy,
  });
}

for (const severity of ['minor', 'important', 'blocking']) {
  test('337 (a): a verified ' + severity + ' finding held under the confidence gate comments, with the local reason', async (t) => {
    const db = fixture(t);
    record(db, [below(severity)]);
    const result = await verdict(db);
    assert.equal(result.exitCode, 0, JSON.stringify(result.output));
    assert.equal(result.output.event, 'COMMENT');
    assert.equal(result.planned.heldBackApproval, true);
    assert.deepEqual(capReason(result.output.reasons), [
      'a finding above a nit was held back, unverified, below the posting tier or below the confidence gate, so this comments rather than approves',
    ]);
    assert.deepEqual(result.output.payload.comments, [], 'nothing new is posted');
    assert.deepEqual(result.planned.held, [], 'the hold is not a finding of the review text');
  });
}

for (const severity of ['nit', 'question']) {
  test('337 (a): a ' + severity + ' held under the confidence gate still approves', async (t) => {
    const db = fixture(t);
    record(db, [below(severity)]);
    const result = await verdict(db);
    assert.equal(result.output.event, 'APPROVE', JSON.stringify(result.output.reasons));
    assert.equal(result.planned.heldBackApproval, false);
    assert.deepEqual(capReason(result.output.reasons), []);
  });
}

test('337 (b): a blocking finding held by the score gate still approves, since that score is preference', async (t) => {
  const db = fixture(t);
  record(db, [below('blocking', { reason: SCORE })]);
  const result = await verdict(db);
  assert.equal(result.output.event, 'APPROVE', JSON.stringify(result.output.reasons));
  assert.equal(result.planned.heldBackApproval, false);
  assert.deepEqual(capReason(result.output.reasons), []);
});

test('337: the predicate reads the verdict, the gate named in the reason and the severity', () => {
  assert.equal(heldBelowConfidenceGate(below('minor')), true);
  assert.equal(heldBelowConfidenceGate(below('minor', { reason: SCORE })), false);
  assert.equal(heldBelowConfidenceGate(below('minor', { verdict: 'owner-declined' })), false, 'a declined finding is no longer below the gate');
  assert.equal(heldBelowConfidenceGate(below('minor', { verdict: 'unverified' })), false);
  assert.equal(heldBelowConfidenceGate(below(undefined)), false, 'no severity cannot be shown to be above a nit, and the driver always writes one');
  assert.equal(heldBelowConfidenceGate(below('nit')), false);
  assert.equal(heldBelowConfidenceGate(below('question')), false);
});

test('337: the verdict, record and review help name the severities the predicate counts, so a question is not read as covered', () => {
  const counted = ['blocking', 'important', 'minor', 'question', 'nit'].filter((severity) => heldBelowConfidenceGate(below(severity)));
  const named = counted.slice(0, -1).join(', ') + ' or ' + counted.at(-1);
  assert.equal(named, 'blocking, important or minor');
  for (const command of ['verdict', 'record', 'review']) {
    const body = COMMAND_HELP[command].body.replace(/\s+/g, ' ');
    // Every mention, since the review help also names below-gate where it describes the held queue.
    const mentions = [...body.matchAll(/below-gate/g)].map((match) => match.index);
    assert.notEqual(mentions.length, 0, command + ' help describes the below-gate hold');
    // "Above a nit" alone would cover a question, which the unverified cap counts and this hold does not.
    assert.ok(mentions.some((at) => body.slice(Math.max(0, at - 150), at + 150).includes(named)), command + ' help names ' + named + ' where it describes the hold');
  }
});

test('337: a review that already comments or requests changes is unchanged by the hold', (t) => {
  const db = fixture(t);
  const plan = (severity) => {
    const output = `[${severity}] \`src/cart.ts:10\` - The ${severity} claim here. It is stated as the contract asks.`;
    const scores = [{ candidateId: 'c10', path: 'src/cart.ts', line: 10, severity: { severity }, confidenceSource: 'verifier', eligible: true }];
    const id = record(db, [below('blocking')], { output, scores }).reviewRunId;
    return planFindings(output, runDetail(db, id), () => null);
  };
  const commented = plan('minor');
  assert.equal(commented.mapped, 'COMMENT');
  assert.equal(commented.heldBackApproval, false, 'the posted finding, not the hold, is why it comments');
  assert.equal(commented.inline.length, 1);
  const requested = plan('important');
  assert.equal(requested.mapped, 'REQUEST_CHANGES', 'a held finding never requests changes');
  assert.equal(requested.inline.length, 1);
  const nit = plan('nit');
  assert.equal(nit.mapped, 'COMMENT');
  assert.equal(nit.heldBackApproval, true);
  assert.equal(nit.inline.length, 1, 'the nit still posts');
});

test('337: the would-have summary names the confidence gate beside the other held causes', async (t) => {
  const db = fixture(t);
  const high = assessComplexity('', [{ path: 'src/auth/login.ts', status: 'modified', class: 'source', language: null, additions: 1, deletions: 0, reviewed: true }]);
  assert.equal(high.level, 'high');
  record(db, [below('important')], { complexity: high });
  const result = await verdict(db);
  assert.equal(result.output.wouldHaveEvent, 'COMMENT');
  assert.equal(result.output.wouldHaveSummary, 'Would have commented: a finding above a nit was held back, unverified, below the posting tier or below the confidence gate.');
});

test('337 (f): the posted body says only that this is not an approval yet, and names no path, line or claim of the held finding', async (t) => {
  const db = fixture(t);
  record(db, [below('blocking')]);
  const plain = await verdict(db);
  assert.equal(plain.output.payload.body, 'Not approving yet.', 'the same body an unverified hold posts');

  // With every optional block on, only the count the scope block already gave for a below-gate hold appears.
  const every = await verdict(db, NO_FINDINGS, { scopeBlock: true, scopeBlockModels: true, readingGuide: true, evidenceBlock: true });
  const posted = JSON.stringify(every.output.payload);
  assert.match(every.output.payload.body, /^Not approving yet\./);
  assert.match(every.output.payload.body, /1 below the gate/);
  for (const secret of ['src/export.ts', 'export.ts', String(LINE), CLAIM, 'tenant', 'cand_001', 'confidence gate']) {
    assert.ok(!posted.includes(secret), `the posted review must not carry ${secret}`);
  }
  assert.deepEqual(every.output.payload.comments, []);
});

// ---- the hold survives a narrowed review (record, through the built bundle) ----

const PULL = ['a.ts', 'b.ts', 'c.ts'];
const hold = (path, line, over = {}) => below('minor', { path, line, text: `the value at ${path}:${line} is never checked`, ...over });
const hunk = (path, line = 1) => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -${line} +${line} @@\n-before\n+after\n`;
const incremental = (files) => (since, priorRunId) => ({ kind: 'incremental', since, priorRunId, priorReviewedAt: null, commits: 1, files });
const interdiff = (files, extra = {}) => (since, priorRunId) => ({ kind: 'interdiff', since, priorRunId, priorReviewedAt: null, mergeBase: since, files, hunks: 1, ...extra });
const full = (since, priorRunId) => ({ kind: 'full', cause: 'requested', since, priorRunId });

/**
 * A pull request whose first review holds `held`. `next` records one more
 * review at a new commit with the scope `scopeOf(since, priorRunId)` names and
 * returns what that run holds and the event its findings call for (`files` is
 * the pull request's file list, null for a manifest with no list). `decline`
 * is the owner declining a held finding of the latest run.
 */
function pull(t, held) {
  const base = mkdtempSync(join(tmpdir(), 'rv-337-chain-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const repo = join(base, 'repo');
  const dataDir = join(base, 'data');
  mkdirSync(repo);
  mkdirSync(dataDir);
  const env = { ...process.env, REVIEW_VOICE_DATA_DIR: dataDir };
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  const commit = (tag) => {
    writeFileSync(join(repo, 'notes.txt'), `${tag}\n`);
    git('add', '-A');
    git('commit', '-q', '-m', `commit ${tag}`);
    return git('rev-parse', 'HEAD');
  };
  let count = 0;
  const record = (head, manifest, { held, text = NO_FINDINGS, patch } = {}) => {
    count += 1;
    const files = join(base, `files-${count}.json`);
    writeFileSync(files, JSON.stringify({ pullNumber: PR, ...manifest }));
    const extra = [];
    if (held !== undefined) {
      writeFileSync(join(base, `held-${count}.json`), JSON.stringify({ held }));
      extra.push('--held', join(base, `held-${count}.json`));
    }
    if (patch !== undefined) {
      writeFileSync(join(base, `diff-${count}.patch`), patch);
      extra.push('--diff-file', join(base, `diff-${count}.patch`));
    }
    const r = spawnSync(process.execPath, [bundle, 'record', '--repository', 'o/r', '--head', head, '--files', files, ...extra], { encoding: 'utf8', input: `${text}\n`, cwd: repo, env });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout).reviewRunId;
  };
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('config', 'commit.gpgsign', 'false');
  let prior = commit('first');
  let runId = record(prior, { files: PULL.map((path) => ({ path })) }, { held });
  return {
    next(scopeOf, { files = PULL, held, text, patch } = {}) {
      const head = commit(`follow ${count}`);
      const scope = scopeOf(prior, runId);
      runId = record(head, { ...(files === null ? {} : { files: files.map((path) => ({ path })) }), scope }, { held, text, patch: patch ?? (scope.files ?? []).map((path) => hunk(path)).join('') });
      prior = head;
      const db = openDatabase(join(dataDir, 'review-voice.db'));
      try {
        const detail = runDetail(db, runId);
        const { mapped } = planFindings(detail.output, detail, (id) => runDetail(db, id));
        return { held: detail.held.map((entry) => `${entry.path}:${entry.line} ${entry.verdict}`), mapped };
      } finally {
        db.close();
      }
    },
    decline(at) {
      const r = spawnSync(process.execPath, [bundle, 'decline', '--run', runId, at], { encoding: 'utf8', cwd: repo, env });
      assert.equal(r.status, 0, r.stderr);
    },
  };
}

test('337 (c): narrowed reviews of other files inherit the hold and cannot approve, and a full review that raises nothing approves', (t) => {
  const chain = pull(t, [hold('a.ts', 20)]);
  assert.deepEqual(chain.next(incremental(['b.ts'])), { held: ['a.ts:20 below-gate'], mapped: 'COMMENT' });
  assert.deepEqual(chain.next(interdiff(['c.ts'])), { held: ['a.ts:20 below-gate'], mapped: 'COMMENT' });
  assert.deepEqual(chain.next(incremental(['a.ts']), { patch: hunk('a.ts', 200) }), { held: ['a.ts:20 below-gate'], mapped: 'COMMENT' }, 'a hunk elsewhere in the file judges nothing at the held line');
  assert.deepEqual(chain.next(full), { held: [], mapped: 'APPROVE' });
  assert.deepEqual(chain.next(incremental(['b.ts'])), { held: [], mapped: 'APPROVE' }, 'the full review judged again, so nothing is left to inherit');
});

test('337: a narrowed review inherits no hold by the score gate and none for a nit or a question', (t) => {
  const chain = pull(t, [hold('a.ts', 20, { reason: SCORE }), hold('a.ts', 30, { severity: 'nit' }), hold('b.ts', 5, { severity: 'question' })]);
  assert.deepEqual(chain.next(incremental(['c.ts'])), { held: [], mapped: 'APPROVE' });
});

test('337 (d): once the owner declines the held finding, the next narrowed review approves', (t) => {
  const chain = pull(t, [hold('a.ts', 20)]);
  assert.deepEqual(chain.next(incremental(['b.ts'])), { held: ['a.ts:20 below-gate'], mapped: 'COMMENT' });
  chain.decline('a.ts:20');
  assert.deepEqual(chain.next(incremental(['b.ts'])), { held: [], mapped: 'APPROVE' });
});

test('337 (e): the hold ends when the pull request no longer changes its file', (t) => {
  const listed = pull(t, [hold('a.ts', 20), hold('c.ts', 7)]);
  assert.deepEqual(listed.next(incremental(['b.ts']), { files: ['b.ts', 'c.ts'] }), { held: ['c.ts:7 below-gate'], mapped: 'COMMENT' }, 'the file list no longer names a.ts');
  const scoped = pull(t, [hold('a.ts', 20)]);
  assert.deepEqual(scoped.next(interdiff(['b.ts'], { noLongerChanged: ['a.ts'] })), { held: [], mapped: 'APPROVE' });
});

test('337: the hold follows a file the patch renames', (t) => {
  const chain = pull(t, [hold('a.ts', 20)]);
  const rename = 'diff --git a/a.ts b/moved.ts\nsimilarity index 100%\nrename from a.ts\nrename to moved.ts\n';
  assert.deepEqual(chain.next(incremental(['moved.ts']), { files: ['moved.ts', 'b.ts', 'c.ts'], patch: rename }), { held: ['moved.ts:20 below-gate'], mapped: 'COMMENT' });
});

// What a narrowed run says about the held place is not a judgement of the held finding (docs/adr/0016, amended).
for (const [verdict, source, reason] of [
  ['unverified', 'verifier', 'the verifier did not answer'],
  ['refuted', 'verifier', 'the caller checks the value first'],
  ['partly', 'cross-check', 'the second pass confirmed half of the claim'],
]) {
  test('337: this run holding the held path and line as ' + verdict + ' does not end the inherited hold, and the review still comments', (t) => {
    const chain = pull(t, [hold('./a.ts', 20, { severity: 'blocking' }), hold('a.ts', 40)]);
    const own = { path: 'a.ts', line: 20, verdict, source, reason, severity: 'minor', text: 'the value at a.ts:20 is never checked' };
    assert.deepEqual(chain.next(incremental(['a.ts']), { held: [own] }), { held: [`a.ts:20 ${verdict}`, './a.ts:20 below-gate', 'a.ts:40 below-gate'], mapped: 'COMMENT' });
    assert.deepEqual(chain.next(incremental(['b.ts'])), { held: ['./a.ts:20 below-gate', 'a.ts:40 below-gate'], mapped: 'COMMENT' }, 'and the next narrowed review inherits it again');
  });
}

test('337: an unrelated claim this run holds at the held path and line leaves a lone blocking hold in place', (t) => {
  const chain = pull(t, [hold('a.ts', 20, { severity: 'blocking' })]);
  const other = { path: 'a.ts', line: 20, verdict: 'refuted', source: 'verifier', reason: 'the loop is bounded by the caller', severity: 'nit', candidateId: 'cand_044', text: 'the loop at a.ts:20 may not end' };
  assert.deepEqual(chain.next(incremental(['a.ts']), { held: [other] }), { held: ['a.ts:20 refuted', 'a.ts:20 below-gate'], mapped: 'COMMENT' });
});

test('337: this run holding the same path and line again under the confidence gate records one entry, not two', (t) => {
  const chain = pull(t, [hold('./a.ts', 20), hold('a.ts', 40)]);
  assert.deepEqual(chain.next(incremental(['a.ts']), { held: [hold('a.ts', 20, { candidateId: 'cand_009' })] }), { held: ['a.ts:20 below-gate', 'a.ts:40 below-gate'], mapped: 'COMMENT' });
});

test('337: a hold of this run that does not cap, by the score gate or for a nit, does not replace the inherited hold', (t) => {
  const chain = pull(t, [hold('a.ts', 20), hold('a.ts', 40)]);
  const result = chain.next(incremental(['a.ts']), { held: [hold('a.ts', 20, { reason: SCORE }), hold('a.ts', 40, { severity: 'nit' })] });
  assert.deepEqual(result, { held: ['a.ts:20 below-gate', 'a.ts:40 below-gate', 'a.ts:20 below-gate', 'a.ts:40 below-gate'], mapped: 'COMMENT' });
});

// Each severity on its own: a rule that read the severity of the raised finding would end the hold for some and not others.
for (const severity of ['blocking', 'important', 'minor', 'question', 'nit']) {
  test('337: a finding the review text raises as ' + severity + ' at the held path and line does not end the inherited hold', (t) => {
    const chain = pull(t, [hold('a.ts', 20), hold('a.ts', 40)]);
    const result = chain.next(incremental(['a.ts']), { text: `[${severity}] \`a.ts:20\` - The value here is read before it is set. It is stated as the contract asks.` });
    assert.deepEqual(result.held, ['a.ts:20 below-gate', 'a.ts:40 below-gate'], 'a finding in the review text is another claim, not a judgement of the held one');
  });
}

test('337: a manifest whose file list is empty ends the hold, and one with no file list or a malformed entry keeps it', (t) => {
  const emptied = pull(t, [hold('a.ts', 20, { severity: 'blocking' })]);
  assert.deepEqual(emptied.next(incremental([]), { files: [] }), { held: [], mapped: 'APPROVE' }, 'an empty list says the pull request changes no file');
  const unlisted = pull(t, [hold('a.ts', 20, { severity: 'blocking' })]);
  assert.deepEqual(unlisted.next(incremental(['b.ts']), { files: null }), { held: ['a.ts:20 below-gate'], mapped: 'COMMENT' }, 'with no list only the scope lists could say the file left');
  const malformed = pull(t, [hold('a.ts', 20, { severity: 'blocking' })]);
  assert.deepEqual(malformed.next(incremental(['b.ts']), { files: ['b.ts', null] }), { held: ['a.ts:20 below-gate'], mapped: 'COMMENT' }, 'a list with an entry that names no file releases nothing');
});
