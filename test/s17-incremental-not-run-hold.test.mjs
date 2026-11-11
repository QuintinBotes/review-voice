/**
 * S17: a hold for a challenger that did not run outlives every review narrower
 * than the pull request (docs/adr/0024, amended). An incremental or interdiff
 * review that links a prior run inherits every one of that run's
 * `challenger not run:` holds, on a file it read or not: it saw its own hunks
 * only, and a hunk at a.ts:200 judges nothing at a.ts:20. A hold ends when the
 * pull request no longer changes its file, which the manifest's file list says
 * for every scope and `scope.noLongerChanged` and `scope.absorbedByBase` say
 * for a manifest without one, or when a full review, which inherits nothing,
 * reads the whole pull request again. A hold follows a file the patch itself
 * renames, and the same finding held again is recorded once.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { openDatabase } from '../plugins/review-voice/src/store/db.ts';
import { runDetail } from '../plugins/review-voice/src/store/runs.ts';
import { planFindings } from '../plugins/review-voice/src/publish/verdict.ts';
import { patchRenames } from '../plugins/review-voice/src/diff/hunks.ts';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bundle = join(root, 'plugins/review-voice/dist/review-voice.mjs');
const NOT_RUN = 'challenger not run: runners.codex is not configured';
const hold = (path, line, candidateId, reason = NOT_RUN) => ({ path, line, verdict: 'challenge-partly', source: 'challenge', reason, severity: 'minor', candidateId, text: `the value at ${path}:${line} is never checked` });

/** What the pull request changes, as files.json lists it whatever the review's scope. */
const PULL = ['a.ts', 'b.ts', 'c.ts'];

/** A patch section that shows one changed line of `path`, at `line`. */
const hunk = (path, line = 1) => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -${line} +${line} @@\n-before\n+after\n`;
/** A patch section for a change of mode alone, which shows no line. */
const modeOnly = (path) => `diff --git a/${path} b/${path}\nold mode 100644\nnew mode 100755\n`;
/** A patch section for a rename with no change of content. */
const renameOnly = (from, to) => `diff --git a/${from} b/${to}\nsimilarity index 100%\nrename from ${from}\nrename to ${to}\n`;
/** A patch section for a rename that also changes one line, at `line`. */
const renameWithHunk = (from, to, line) => `diff --git a/${from} b/${to}\nsimilarity index 90%\nrename from ${from}\nrename to ${to}\n--- a/${from}\n+++ b/${to}\n@@ -${line} +${line} @@\n-before\n+after\n`;

/**
 * Records a run holding `held`, then one clean review per entry of `follow`,
 * each recorded at a new commit with the scope `scope(since, priorRunId)`
 * names. An entry is that function, or a list of it, the pull request's file
 * list at that commit (null for a manifest with no list) and the patch the
 * review read (one hunk in each scope file when omitted, null for no patch)
 * and the entries that review holds itself.
 * Returns each follow-up run's held entries and event.
 */
function chain(t, held, follow) {
  const base = mkdtempSync(join(tmpdir(), 'rv-s17-incremental-hold-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const repo = join(base, 'repo');
  const dataDir = join(base, 'data');
  mkdirSync(repo);
  mkdirSync(dataDir);
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  const record = (head, manifest, extra = []) => {
    const files = join(base, `files-${head}.json`);
    writeFileSync(files, JSON.stringify({ pullNumber: 7, ...manifest }));
    const r = spawnSync(process.execPath, [bundle, 'record', '--repository', 'o/r', '--head', head, '--files', files, ...extra], {
      encoding: 'utf8',
      input: 'No actionable findings.\n',
      cwd: repo,
      env: { ...process.env, REVIEW_VOICE_DATA_DIR: dataDir },
    });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout).reviewRunId;
  };
  const commit = (tag) => {
    writeFileSync(join(repo, 'notes.txt'), `${tag}\n`);
    git('add', '-A');
    git('commit', '-q', '-m', `commit ${tag}`);
    return git('rev-parse', 'HEAD');
  };
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('config', 'commit.gpgsign', 'false');
  let prior = commit('first');
  const heldFile = join(base, 'held.json');
  writeFileSync(heldFile, JSON.stringify({ held }));
  const first = record(prior, { files: [{ path: 'a.ts' }, { path: 'b.ts' }, { path: 'c.ts' }] }, ['--held', heldFile]);
  let runId = first;
  const results = [];
  for (const [index, entry] of follow.entries()) {
    const [scopeOf, pull = PULL, patch, again] = [entry].flat();
    const head = commit(`follow ${index}`);
    const scope = scopeOf(prior, runId);
    const text = patch === undefined ? (scope.files ?? []).map(hunk).join('') : patch;
    const diffFile = join(base, `diff-${index}.patch`);
    if (text !== null) writeFileSync(diffFile, text);
    const againFile = join(base, `held-${index}.json`);
    if (again !== undefined) writeFileSync(againFile, JSON.stringify({ held: again }));
    const next = record(head, pull === null ? { scope } : { files: pull.map((path) => (typeof path === 'string' ? { path } : path)), scope }, [
      ...(text === null ? [] : ['--diff-file', diffFile]),
      ...(again === undefined ? [] : ['--held', againFile]),
    ]);
    const db = openDatabase(join(dataDir, 'review-voice.db'));
    try {
      const detail = runDetail(db, next);
      const { mapped } = planFindings('No actionable findings.\n', detail, (id) => runDetail(db, id));
      results.push({ held: detail.held.map((entry) => `${entry.path}:${entry.line}`), mapped, priorRunId: detail.scope?.priorRunId ?? null });
    } finally {
      db.close();
    }
    prior = head;
    runId = next;
  }
  return { results, first };
}

const incremental = (files) => (since, priorRunId) => ({ kind: 'incremental', since, priorRunId, priorReviewedAt: null, commits: 1, files });
const interdiff = (files, extra = {}) => (since, priorRunId) => ({ kind: 'interdiff', since, priorRunId, priorReviewedAt: null, mergeBase: since, files, hunks: 1, ...extra });

test('S17: an incremental review of another file inherits a challenger-not-run hold and cannot approve', (t) => {
  const { results, first } = chain(t, [hold('a.ts', 20, 'cand_001')], [incremental(['b.ts'])]);
  assert.equal(results[0].priorRunId, first, 'the prior-run link is recorded');
  assert.deepEqual(results[0].held, ['a.ts:20']);
  assert.equal(results[0].mapped, 'COMMENT');
});

test('S17: an incremental review with a hunk elsewhere in the held file inherits the hold, and so does the next one', (t) => {
  const elsewhere = [incremental(['a.ts']), PULL, hunk('a.ts', 200)];
  const { results } = chain(t, [hold('a.ts', 20, 'cand_001')], [elsewhere, elsewhere]);
  assert.deepEqual(results.map((result) => [result.held, result.mapped]), [
    [['a.ts:20'], 'COMMENT'],
    [['a.ts:20'], 'COMMENT'],
  ]);
});

test('S17: an interdiff review with a hunk elsewhere in the held file inherits the hold, and so does the next one', (t) => {
  const elsewhere = [interdiff(['a.ts']), PULL, hunk('a.ts', 200)];
  const { results } = chain(t, [hold('a.ts', 20, 'cand_001')], [elsewhere, elsewhere]);
  assert.deepEqual(results.map((result) => [result.held, result.mapped]), [
    [['a.ts:20'], 'COMMENT'],
    [['a.ts:20'], 'COMMENT'],
  ]);
});

test('S17: the inherited hold travels through a chain of narrowed reviews, the ones that read its file included', (t) => {
  const { results } = chain(t, [hold('a.ts', 20, 'cand_001')], [incremental(['b.ts']), interdiff(['c.ts']), incremental(['a.ts']), interdiff(['a.ts', 'b.ts'])]);
  assert.deepEqual(results.map((result) => [result.held, result.mapped]), [
    [['a.ts:20'], 'COMMENT'],
    [['a.ts:20'], 'COMMENT'],
    [['a.ts:20'], 'COMMENT'],
    [['a.ts:20'], 'COMMENT'],
  ]);
});

test('S17: a narrowed review that read the held file inherits its not-run hold, and no other kind of hold', (t) => {
  const { results } = chain(t, [hold('b.ts', 5, 'cand_001'), hold('a.ts', 20, 'cand_002', 'unverified: the verifier did not answer')], [interdiff(['b.ts'])]);
  assert.deepEqual(results[0].held, ['b.ts:5']);
  assert.equal(results[0].mapped, 'COMMENT');
});

test('S17: a finding held again at the same path and line is recorded once, beside the other inherited holds', (t) => {
  const again = [hold('a.ts', 20, 'cand_009', 'challenger not run: runners.codex timed out')];
  const { results } = chain(t, [hold('./a.ts', 20, 'cand_001'), hold('a.ts', 40, 'cand_002')], [
    [incremental(['a.ts']), PULL, hunk('a.ts', 20), again],
    [incremental(['a.ts']), PULL, hunk('a.ts', 200)],
  ]);
  assert.deepEqual(results.map((result) => [result.held, result.mapped]), [
    [['a.ts:20', 'a.ts:40'], 'COMMENT'],
    [['a.ts:20', 'a.ts:40'], 'COMMENT'],
  ]);
});

test('S17: an interdiff review drops an inherited hold on a file the pull request no longer changes', (t) => {
  const { results } = chain(t, [hold('a.ts', 20, 'cand_001'), hold('c.ts', 7, 'cand_002')], [interdiff(['b.ts'], { noLongerChanged: ['a.ts'] })]);
  assert.deepEqual(results[0].held, ['c.ts:7']);
  assert.equal(results[0].mapped, 'COMMENT');
});

test('S17: a full review inherits nothing, since it reads the whole pull request', (t) => {
  const { results } = chain(t, [hold('a.ts', 20, 'cand_001')], [(since, priorRunId) => ({ kind: 'full', cause: 'requested', since, priorRunId })]);
  assert.deepEqual(results[0].held, []);
  assert.equal(results[0].mapped, 'APPROVE');
});

test('S17: an incremental review drops an inherited hold once the pull request file list no longer names its file', (t) => {
  // An incremental scope carries no noLongerChanged list, so only the manifest says a.ts left the pull request.
  const { results } = chain(t, [hold('a.ts', 20, 'cand_001'), hold('c.ts', 7, 'cand_002')], [[incremental(['b.ts']), ['b.ts', 'c.ts']], [incremental(['b.ts']), ['b.ts', 'c.ts']]]);
  assert.deepEqual(results.map((result) => [result.held, result.mapped]), [
    [['c.ts:7'], 'COMMENT'],
    [['c.ts:7'], 'COMMENT'],
  ]);
});

test('S17: a hold on a renamed file is kept under its old name while the pull request still lists the rename', (t) => {
  const { results } = chain(t, [hold('a.ts', 20, 'cand_001')], [[incremental(['b.ts']), [{ path: 'moved.ts', previousPath: 'a.ts' }, 'b.ts']]]);
  assert.deepEqual(results[0].held, ['a.ts:20']);
  assert.equal(results[0].mapped, 'COMMENT');
});

for (const [label, pull] of [['a manifest with the pull request file list', ['b.ts', 'c.ts']], ['a manifest with no file list', null]]) {
  test(`S17: an interdiff review drops an inherited hold on a file the base absorbed, from ${label}`, (t) => {
    const { results } = chain(t, [hold('a.ts', 20, 'cand_001'), hold('c.ts', 7, 'cand_002')], [[interdiff(['b.ts'], { absorbedByBase: ['a.ts'] }), pull]]);
    assert.deepEqual(results[0].held, ['c.ts:7']);
    assert.equal(results[0].mapped, 'COMMENT');
  });
}

test('S17: a hold whose path the analyst wrote with a leading ./ is inherited by a review that read the file, under the spelling it had', (t) => {
  const { results } = chain(t, [hold('./b.ts', 5, 'cand_001'), hold('src/../c.ts', 7, 'cand_002')], [interdiff(['b.ts', 'c.ts'])]);
  assert.deepEqual(results[0].held, ['./b.ts:5', 'src/../c.ts:7']);
  assert.equal(results[0].mapped, 'COMMENT');
});

test('S17: a dotted hold path is still inherited for a file outside the scope, and settled when the pull request no longer changes it', (t) => {
  const { results } = chain(t, [hold('./a.ts', 20, 'cand_001'), hold('./c.ts', 7, 'cand_002')], [[interdiff(['b.ts'], { noLongerChanged: ['a.ts'] }), null]]);
  assert.deepEqual(results[0].held, ['./c.ts:7']);
  assert.equal(results[0].mapped, 'COMMENT');
});

// ---- a hold follows its file through a rename, and no narrowed review of the file ends it

test('S17: a narrowed review that lists the held file with no hunk, or records no patch, keeps the hold as any other does', (t) => {
  const { results } = chain(t, [hold('a.ts', 20, 'cand_001')], [
    [interdiff(['a.ts'], { hunks: 0 }), PULL, modeOnly('a.ts')],
    [interdiff(['a.ts'], { hunks: 0 }), PULL, null],
    incremental(['a.ts']),
  ]);
  assert.deepEqual(results.map((result) => [result.held, result.mapped]), [
    [['a.ts:20'], 'COMMENT'],
    [['a.ts:20'], 'COMMENT'],
    [['a.ts:20'], 'COMMENT'],
  ]);
});

test('S17: a hold on a file the pull request renamed stays through a narrowed review that reads the file under its new name', (t) => {
  const pull = [{ path: 'moved.ts', previousPath: 'a.ts' }, 'b.ts'];
  const { results } = chain(t, [hold('a.ts', 20, 'cand_001')], [[incremental(['b.ts']), pull], [interdiff(['moved.ts']), pull], [incremental(['b.ts']), pull]]);
  assert.deepEqual(results.map((result) => [result.held, result.mapped]), [
    [['a.ts:20'], 'COMMENT'],
    [['a.ts:20'], 'COMMENT'],
    [['a.ts:20'], 'COMMENT'],
  ]);
});

test('S17: a hold follows a file the review patch renames with a hunk elsewhere in it, and stays through the next review of the new name', (t) => {
  const pull = [{ path: 'moved.ts', previousPath: 'a.ts' }, 'b.ts', 'c.ts'];
  const { results } = chain(t, [hold('a.ts', 20, 'cand_001')], [
    [incremental(['moved.ts']), pull, renameWithHunk('a.ts', 'moved.ts', 200)],
    [interdiff(['moved.ts']), pull, hunk('moved.ts', 200)],
  ]);
  assert.deepEqual(results.map((result) => [result.held, result.mapped]), [
    [['moved.ts:20'], 'COMMENT'],
    [['moved.ts:20'], 'COMMENT'],
  ]);
});

test('S17: a hold under a name the pull request renames again follows the file, and stays when a review reads it', (t) => {
  // c.ts was itself a rename target, so the pull request's file list names only the first and the last name.
  const pull = ['a.ts', 'b.ts', { path: 'd.ts', previousPath: 'origin.ts' }];
  const { results } = chain(t, [hold('./c.ts', 7, 'cand_001')], [
    [interdiff(['d.ts'], { hunks: 0 }), pull, renameOnly('c.ts', 'd.ts')],
    [incremental(['b.ts']), pull],
    [incremental(['d.ts']), pull],
  ]);
  assert.deepEqual(results.map((result) => [result.held, result.mapped]), [
    [['d.ts:7'], 'COMMENT'],
    [['d.ts:7'], 'COMMENT'],
    [['d.ts:7'], 'COMMENT'],
  ]);
});

test('S17: a rename is read from a patch header only, quoted or not, never from a line of a hunk', () => {
  const patch = [
    'diff --git a/old.ts b/new.ts',
    'similarity index 90%',
    'rename from old.ts',
    'rename to new.ts',
    '--- a/old.ts',
    '+++ b/new.ts',
    '@@ -1,2 +1,2 @@',
    'rename from x.ts',
    'rename to y.ts',
    'diff --git "a/caf\\303\\251.ts" "b/th\\303\\251.ts"',
    'rename from "caf\\303\\251.ts"',
    'rename to "th\\303\\251.ts"',
    '',
  ].join('\n');
  assert.deepEqual([...patchRenames(patch)], [['old.ts', 'new.ts'], ['caf\u00e9.ts', 'th\u00e9.ts']]);
});

test('S17: a manifest whose file list is empty ends an inherited hold, and a manifest with no file list keeps it', (t) => {
  // Every change of the pull request was taken back, so its list is there and names nothing.
  const emptied = chain(t, [hold('a.ts', 20, 'cand_001')], [[incremental([]), []]]);
  assert.deepEqual([emptied.results[0].held, emptied.results[0].mapped], [[], 'APPROVE']);
  const unlisted = chain(t, [hold('a.ts', 20, 'cand_001')], [[incremental(['b.ts']), null]]);
  assert.deepEqual([unlisted.results[0].held, unlisted.results[0].mapped], [['a.ts:20'], 'COMMENT']);
});
