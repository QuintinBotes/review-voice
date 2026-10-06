/**
 * A prior comment the author only partly addressed. The owner's nit listed four
 * stale points in a rule document and the author fixed two. The remaining two
 * came back as candidates, and were either new findings that re-posted most of
 * the comment, or repeats to be dropped, which lost the two still open.
 *
 * Now the candidate reaches the verifier linked to the owner's comment, the
 * verifier says what remains, `score` keeps it as an ordinary finding carrying
 * that state, and `record` stores it as partly addressed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bundle = join(root, 'plugins/review-voice/dist/review-voice.mjs');

const OWNER = 'owner-login';
const PATH = 'docs/rules.md';
const CLAIM = 'The rule document still names the retired queue and the old timeout setting';
const FAILURE = 'readers follow stale guidance for queue names and timeout values';
const NIT = `Four stale points: ${CLAIM}; ${FAILURE}; the deploy step; the owner list.`;

function run(args, input, dir) {
  const r = spawnSync(process.execPath, [bundle, ...args], {
    encoding: 'utf8',
    input,
    cwd: dir,
    env: { ...process.env, REVIEW_VOICE_DATA_DIR: dir },
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

const candidate = (id, line) => ({
  candidate_id: id,
  path: PATH,
  line,
  category: 'documentation',
  severity: 'nit',
  claim: CLAIM,
  failure_mode: FAILURE,
  evidence: [`${PATH}:${line} still names the retired queue`],
  technical_confidence: 0.92,
});

const ownComment = { path: PATH, line: 12, author: OWNER, body: NIT, kind: 'review-comment' };
const botComment = { ...ownComment, author: 'acme-bot' };

function withDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'rv-issue-30-'));
  try {
    const patch = join(dir, 'diff.patch');
    writeFileSync(
      patch,
      [`diff --git a/${PATH} b/${PATH}`, '--- /dev/null', `+++ b/${PATH}`, '@@ -0,0 +1,30 @@',
        ...Array.from({ length: 30 }, (_, i) => `+line ${i + 1}`)].join('\n'),
    );
    return fn(dir, patch);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function writeJson(dir, name, value) {
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(value));
  return path;
}

const PARTLY = { remaining: ['the retired queue name', 'the old timeout setting'], addressed: ['the deploy step', 'the owner list'] };

test("check-candidates sends a restatement of the owner's own comment to the verifier instead of dropping it", () =>
  withDir((dir, patch) => {
    const thread = writeJson(dir, 'thread.json', { comments: [ownComment] });
    const r = run(['check-candidates', '--diff-file', patch, '--thread', thread, '--owner', OWNER], JSON.stringify({ candidates: [candidate('c1', 12)] }), dir);
    assert.equal(r.code, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.deepEqual(out.droppedAsRepeat, []);
    assert.equal(out.kept[0].possibleRepeatOf.kind, 'own-comment');

    // Anyone else's comment is still dropped as a repeat before verification.
    const other = writeJson(dir, 'other.json', { comments: [botComment] });
    const dropped = JSON.parse(run(['check-candidates', '--diff-file', patch, '--thread', other, '--owner', OWNER], JSON.stringify({ candidates: [candidate('c1', 12)] }), dir).stdout);
    assert.equal(dropped.droppedAsRepeat.length, 1);
  }));

test('a possibleRepeatOf arriving from the analyst is not passed on', () =>
  withDir((dir, patch) => {
    const thread = writeJson(dir, 'thread.json', { comments: [] });
    const forged = { ...candidate('c1', 20), possibleRepeatOf: { kind: 'own-comment', author: OWNER, path: PATH, line: 12 } };
    const out = JSON.parse(run(['check-candidates', '--diff-file', patch, '--thread', thread, '--owner', OWNER], JSON.stringify({ candidates: [forged] }), dir).stdout);
    assert.equal(out.kept[0].possibleRepeatOf, undefined);
  }));

function scoreLinked(dir, verification, thread = [ownComment]) {
  const linked = { ...candidate('c1', 12), possibleRepeatOf: { kind: 'own-comment', author: OWNER, path: PATH, line: 12, excerpt: NIT } };
  return run(
    ['score', '--verification', writeJson(dir, 'v.json', [verification]), '--thread', writeJson(dir, 't.json', { comments: thread }), '--owner', OWNER],
    JSON.stringify({ candidates: [linked] }),
    dir,
  );
}

test('score keeps a partly-addressed follow-up the thread would otherwise reject, and carries what remains', () =>
  withDir((dir) => {
    const r = scoreLinked(dir, { candidate_id: 'c1', evidence_quality: 'high', technical_confidence: 0.92, partly_addressed: PARTLY });
    assert.equal(r.code, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.eligible.length, 1, JSON.stringify(out.scores?.[0]?.rejectedBecause));
    assert.deepEqual(out.eligible[0].possibleRepeatOf, {
      kind: 'own-comment',
      status: 'partly-addressed',
      author: OWNER,
      path: PATH,
      line: 12,
      ...PARTLY,
    });
  }));

test('without partly_addressed the same candidate is still rejected as already said', () =>
  withDir((dir) => {
    const r = scoreLinked(dir, { candidate_id: 'c1', evidence_quality: 'high', technical_confidence: 0.92 });
    assert.equal(r.code, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.eligible.length, 0);
    assert.match(JSON.stringify(out.scores), /already said on this pull request by owner-login/);
  }));

test('partly_addressed is ignored, with a warning, when the linked comment is not on the thread', () =>
  withDir((dir) => {
    const r = scoreLinked(dir, { candidate_id: 'c1', evidence_quality: 'high', technical_confidence: 0.92, partly_addressed: PARTLY }, [botComment]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stderr, /c1 is marked partly_addressed but is not linked/);
    // The other reviewer's identical comment still rejects it.
    assert.equal(JSON.parse(r.stdout).eligible.length, 0);
  }));

test('a malformed partly_addressed is refused', () =>
  withDir((dir) => {
    for (const bad of [{ remaining: [], addressed: ['x'] }, { remaining: ['x'], addressed: [] }, { remaining: ['x'] }, ['x']]) {
      const r = scoreLinked(dir, { candidate_id: 'c1', evidence_quality: 'high', partly_addressed: bad });
      assert.equal(r.code, 2, JSON.stringify(bad));
      assert.match(r.stderr, /partly_addressed/);
    }
  }));

test('record keeps the partly-addressed state on the finding, and explain shows what is still open', () =>
  withDir((dir) => {
    const scored = scoreLinked(dir, { candidate_id: 'c1', evidence_quality: 'high', technical_confidence: 0.92, partly_addressed: PARTLY });
    const candidates = writeJson(dir, 'scored.json', { candidates: JSON.parse(scored.stdout).eligible });
    const review = `[nit] \`${PATH}:12\` - 2 of 4 stale points remain: the retired queue name and the old timeout setting. Readers follow stale guidance.\n`;
    const done = run(['record', '--repository', 'o/r', '--head', 'abc', '--candidates', candidates], review, dir);
    assert.equal(done.code, 0, done.stderr);
    const { reviewRunId, findings } = JSON.parse(done.stdout);
    assert.deepEqual(findings[0].partlyAddressed, {
      status: 'partly-addressed',
      prior: { author: OWNER, path: PATH, line: 12 },
      ...PARTLY,
    });
    const text = run(['explain', '--run', reviewRunId], '', dir).stdout;
    assert.match(text, /partly addressed {2}owner-login at docs\/rules\.md:12; 2 of 4 still open: the retired queue name; the old timeout setting/);
  }));
