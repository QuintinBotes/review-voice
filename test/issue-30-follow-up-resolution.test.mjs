/**
 * A partly-addressed follow-up tracked to resolution. A finding recorded as
 * partly addressed said what of the owner's comment was still open at that
 * run, and nothing ever marked it settled.
 *
 * Now a later run of the same pull request records each open follow-up as
 * resolved when its posted comment's thread is resolved, or when the verifier
 * found every remaining point addressed, and as open otherwise - including
 * when the file was not in the later review. `explain` shows which.
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
const REPO = 'acme/web';
const PR = 9;
const PATH = 'docs/rules.md';
const REMAINING = ['the retired queue name', 'the old timeout setting'];
const PROSE = '2 of 4 stale points remain: the retired queue name and the old timeout setting. Readers follow stale guidance.';
const REVIEW = `[nit] \`${PATH}:12\` - ${PROSE}\n`;

function run(dir, args, input = '') {
  const r = spawnSync(process.execPath, [bundle, ...args], {
    encoding: 'utf8',
    input,
    cwd: dir,
    env: { ...process.env, REVIEW_VOICE_DATA_DIR: dir },
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

function writeJson(dir, name, value) {
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(value));
  return path;
}

/** Records the run that left a follow-up open, and returns the scenario. */
function withFollowUp(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'rv-issue-30-resolution-'));
  try {
    const candidates = writeJson(dir, 'scored.json', {
      candidates: [
        {
          path: PATH,
          line: 12,
          category: 'documentation',
          possibleRepeatOf: {
            kind: 'own-comment',
            status: 'partly-addressed',
            author: OWNER,
            path: PATH,
            line: 12,
            remaining: REMAINING,
            addressed: ['the deploy step', 'the owner list'],
          },
        },
      ],
    });
    const first = run(dir, ['record', '--repository', REPO, '--head', 'a'.repeat(40), '--candidates', candidates, '--files', writeJson(dir, 'files1.json', { pullNumber: PR })], REVIEW);
    assert.equal(first.code, 0, first.stderr);
    const runId = JSON.parse(first.stdout).reviewRunId;
    return fn({ dir, runId, id: `${runId}:rv_01` });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A later run of the same pull request, which reviewed only `files`. */
function later(s, extra = [], files = ['src/other.ts']) {
  const manifest = writeJson(s.dir, `files-${Math.random().toString(36).slice(2)}.json`, {
    pullNumber: PR,
    scope: { kind: 'interdiff', since: 'a'.repeat(40), priorRunId: s.runId, priorReviewedAt: null, mergeBase: 'b'.repeat(40), files, hunks: 1 },
  });
  const r = run(s.dir, ['record', '--repository', REPO, '--head', 'c'.repeat(40), '--files', manifest, ...extra], 'No actionable findings.\n');
  assert.equal(r.code, 0, r.stderr);
  return JSON.parse(r.stdout);
}

const openList = (s) => JSON.parse(run(s.dir, ['follow-ups', '--pr', String(PR), '--repository', REPO]).stdout).followUps;

// Posted after the run that recorded the follow-up, as `post` only sends a recorded review.
const AFTER = () => new Date(Date.now() + 60_000).toISOString();
const posted = (extra) => ({ path: PATH, line: 12, author: OWNER, body: `**nit** - ${PROSE}`, kind: 'review-comment', createdAt: AFTER(), ...extra });
const threadFile = (s, comments) => writeJson(s.dir, `thread-${Math.random().toString(36).slice(2)}.json`, { repository: REPO, pullNumber: PR, comments });

test('follow-ups lists the open follow-up of the pull request for the verifier', () =>
  withFollowUp((s) => {
    const list = openList(s);
    assert.equal(list.length, 1);
    assert.equal(list[0].id, s.id);
    assert.deepEqual(list[0].remaining, REMAINING);
  }));

test('a later run whose interdiff left the file out keeps the follow-up open', () =>
  withFollowUp((s) => {
    const out = later(s, ['--thread', threadFile(s, [posted({})])]);
    assert.equal(out.followUps.length, 1);
    assert.equal(out.followUps[0].status, 'open');
    assert.match(out.followUps[0].reason, /not in this review/);
    assert.equal(openList(s).length, 1);
    assert.match(run(s.dir, ['explain', '--run', s.runId]).stdout, /follow-up {9}open as of run/);
  }));

test("a resolved thread on the follow-up's posted comment resolves it, and explain says so", () =>
  withFollowUp((s) => {
    // GitHub moved the comment 30 lines down; its wording still finds it.
    const thread = threadFile(s, [posted({ line: 42, resolved: true, resolvedBy: OWNER })]);
    const out = later(s, ['--thread', thread]);
    assert.equal(out.followUps[0].status, 'resolved');
    assert.equal(out.followUps[0].resolvedBy, 'thread');
    assert.deepEqual(openList(s), []);
    assert.match(run(s.dir, ['explain', '--run', s.runId]).stdout, /follow-up {9}resolved in run .* - the owner resolved its comment thread/);
    assert.match(run(s.dir, ['explain', '--run', out.reviewRunId]).stdout, /\[resolved\] rv_01 of run/);
    // Resolved stays resolved on a later run with no evidence at all.
    assert.equal(later(s).followUps, undefined);
  }));

test("the owner's original comment being resolved does not resolve the follow-up", () =>
  withFollowUp((s) => {
    // Itself posted by an earlier review, so it carries the same form.
    const original = {
      path: PATH, line: 12, author: OWNER, kind: 'review-comment', resolved: true, resolvedBy: OWNER,
      body: `**nit** - Four stale points: ${REMAINING.join('; ')}; the deploy step; the owner list. Readers follow stale guidance.`,
      createdAt: '2020-01-01T00:00:00Z',
    };
    const out = later(s, ['--thread', threadFile(s, [original])], [PATH]);
    assert.equal(out.followUps[0].status, 'open');
    assert.equal(openList(s).length, 1);
  }));

test('the verifier finding every remaining point addressed resolves it; some still open keeps it open', () =>
  withFollowUp((s) => {
    const partial = writeJson(s.dir, 'v1.json', {
      verifications: [],
      follow_ups: [{ id: s.id, remaining: ['the old timeout setting'], addressed: ['the retired queue name'], reason: 'queue renamed' }],
    });
    const first = later(s, ['--follow-ups', partial]);
    assert.equal(first.followUps[0].status, 'open');
    assert.deepEqual(first.followUps[0].remaining, ['the old timeout setting']);
    assert.deepEqual(openList(s)[0].remaining, ['the old timeout setting']);

    const done = writeJson(s.dir, 'v2.json', { follow_ups: [{ id: s.id, remaining: [], addressed: ['the old timeout setting'] }] });
    const second = later(s, ['--follow-ups', done]);
    assert.equal(second.followUps[0].status, 'resolved');
    assert.equal(second.followUps[0].resolvedBy, 'verifier');
    assert.deepEqual(openList(s), []);
  }));

test('a malformed follow-up ruling is refused and nothing is recorded', () =>
  withFollowUp((s) => {
    for (const bad of [{ follow_ups: [{ id: s.id, remaining: [], addressed: [] }] }, { follow_ups: [{ id: s.id }] }, { other: [] }]) {
      const manifest = writeJson(s.dir, 'files-bad.json', { pullNumber: PR });
      const r = run(s.dir, ['record', '--repository', REPO, '--head', 'c'.repeat(40), '--files', manifest, '--follow-ups', writeJson(s.dir, 'bad.json', bad)], 'No actionable findings.\n');
      assert.equal(r.code, 2, JSON.stringify(bad));
      assert.match(r.stderr, /follow-up rulings/);
    }
    assert.equal(openList(s).length, 1);
  }));
