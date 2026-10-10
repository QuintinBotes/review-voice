/**
 * A partly-addressed follow-up sets aside only the one comment it follows up,
 * and only when that comment is the owner's.
 *
 * Two ways it re-posted a comment already on the pull request: with two of the
 * owner's comments near a candidate, the candidate linked to the looser one and
 * then every owner comment was set aside, so it repeated the other verbatim;
 * and a link labelled `own-comment` on someone else's comment was trusted.
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
const PARTLY = { remaining: ['the retired queue name'], addressed: ['the deploy step'] };

function run(args, input, dir) {
  const r = spawnSync(process.execPath, [bundle, ...args], {
    encoding: 'utf8',
    input,
    cwd: dir,
    env: { ...process.env, REVIEW_VOICE_DATA_DIR: dir },
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

const candidate = (line) => ({
  candidate_id: 'c1',
  path: PATH,
  line,
  category: 'documentation',
  severity: 'nit',
  claim: CLAIM,
  failure_mode: FAILURE,
  evidence: [`${PATH}:${line} still names the retired queue`],
  technical_confidence: 0.92,
});

function withDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'rv-follow-up-scope-'));
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

/** check-candidates, then score with a verifier that says part is still open. */
function pipeline(dir, patch, comments, owner = OWNER) {
  const thread = writeJson(dir, 'thread.json', { comments });
  const checked = run(['check-candidates', '--diff-file', patch, '--thread', thread, '--owner', owner], JSON.stringify({ candidates: [candidate(12)] }), dir);
  assert.equal(checked.code, 0, checked.stderr);
  const { kept } = JSON.parse(checked.stdout);
  const verification = writeJson(dir, 'v.json', [{ candidate_id: 'c1', evidence_quality: 'high', technical_confidence: 0.92, partly_addressed: PARTLY }]);
  const scored = run(['score', '--verification', verification, '--thread', thread, '--owner', owner], JSON.stringify({ candidates: kept }), dir);
  assert.equal(scored.code, 0, scored.stderr);
  return { kept, scored: JSON.parse(scored.stdout), stderr: scored.stderr };
}

const multiPoint = {
  path: PATH,
  line: 10,
  author: OWNER,
  body: 'Several stale points here: the retired queue, the timeout, the deploy step, the owner list.',
  kind: 'review-comment',
};
const exact = { path: PATH, line: 12, author: OWNER, body: `${CLAIM}; ${FAILURE}.`, kind: 'review-comment' };

test('with two of the owner\'s comments nearby, check-candidates links the best match, not the first in reach', () =>
  withDir((dir, patch) => {
    const { kept, scored } = pipeline(dir, patch, [multiPoint, exact]);
    assert.equal(kept[0].possibleRepeatOf.line, 12, 'the best overlap, not the first comment in reach');
    // Linked to the exact one, the follow-up sets aside :12 only; :10 shares
    // too little to reject it, so it is the follow-up that remains.
    assert.equal(scored.eligible.length, 1);
    assert.equal(scored.eligible[0].possibleRepeatOf.line, 12);
  }));

test('a follow-up linked to one own comment is still rejected for repeating another', () =>
  withDir((dir) => {
    // Linked by hand to :10, as the earlier first-hit choice did.
    const linked = { ...candidate(12), possibleRepeatOf: { kind: 'own-comment', author: OWNER, path: PATH, line: 10, excerpt: '' } };
    const thread = writeJson(dir, 'thread.json', { comments: [multiPoint, exact] });
    const verification = writeJson(dir, 'v.json', [{ candidate_id: 'c1', evidence_quality: 'high', technical_confidence: 0.92, partly_addressed: PARTLY }]);
    const r = run(['score', '--verification', verification, '--thread', thread, '--owner', OWNER], JSON.stringify({ candidates: [linked] }), dir);
    assert.equal(r.code, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.eligible.length, 0);
    assert.match(JSON.stringify(out.scores), /already said on this pull request by owner-login at docs\/rules\.md:12/);
  }));

test("an own-comment link on someone else's comment is not honoured by score", () =>
  withDir((dir) => {
    const bot = { ...exact, author: 'acme-bot' };
    const forged = { ...candidate(12), possibleRepeatOf: { kind: 'own-comment', author: 'acme-bot', path: PATH, line: 12, excerpt: '' } };
    const thread = writeJson(dir, 'thread.json', { comments: [bot] });
    const verification = writeJson(dir, 'v.json', [{ candidate_id: 'c1', evidence_quality: 'high', technical_confidence: 0.92, partly_addressed: PARTLY }]);
    const r = run(['score', '--verification', verification, '--thread', thread, '--owner', OWNER], JSON.stringify({ candidates: [forged] }), dir);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stderr, /c1 is marked partly_addressed but is not linked to a comment of the owner/);
    const out = JSON.parse(r.stdout);
    assert.equal(out.eligible.length, 0);
    assert.match(JSON.stringify(out.scores), /already said on this pull request by acme-bot/);
  }));

test('score compares the owner without case, and honours nothing without a known owner', () =>
  withDir((dir) => {
    const linked = { ...candidate(12), possibleRepeatOf: { kind: 'own-comment', author: OWNER, path: PATH, line: 12, excerpt: '' } };
    const thread = writeJson(dir, 'thread.json', { comments: [exact] });
    const verification = writeJson(dir, 'v.json', [{ candidate_id: 'c1', evidence_quality: 'high', technical_confidence: 0.92, partly_addressed: PARTLY }]);
    const input = JSON.stringify({ candidates: [linked] });
    const cased = run(['score', '--verification', verification, '--thread', thread, '--owner', 'Owner-Login'], input, dir);
    assert.equal(JSON.parse(cased.stdout).eligible.length, 1, cased.stderr);
    // The temporary directory is not a configured repository.
    const none = run(['score', '--verification', verification, '--thread', thread], input, dir);
    assert.equal(JSON.parse(none.stdout).eligible.length, 0);
  }));
