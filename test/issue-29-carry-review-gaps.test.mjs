/**
 * Gaps an adversarial review found in carrying a review to a moved head
 * (docs/adr/0015): unanalysed commits, code changed beside an anchor, serious
 * findings left behind, held findings on old lines, and a half-written
 * re-anchor.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { openDatabase } from '../plugins/review-voice/src/store/db.ts';
import { databasePath } from '../plugins/review-voice/src/store/paths.ts';
import { recordRun, runDetail } from '../plugins/review-voice/src/store/runs.ts';
import { GitHubClient } from '../plugins/review-voice/src/github/client.ts';
import { computeVerdict } from '../plugins/review-voice/src/publish/post.ts';
import { decide } from '../plugins/review-voice/src/publish/verdict.ts';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bundle = join(root, 'plugins/review-voice/dist/review-voice.mjs');

const lines = (n) => Array.from({ length: n }, (_, i) => `line ${i + 1}\n`).join('');
const newFileDiff = (path, body) => {
  const rows = body.split('\n').slice(0, -1);
  return [`diff --git a/${path} b/${path}`, 'new file mode 100644', '--- /dev/null', `+++ b/${path}`, `@@ -0,0 +1,${rows.length} @@`, ...rows.map((r) => `+${r}`), ''].join('\n');
};

function run(args, { cwd, dataDir, input = '' }) {
  const result = spawnSync(process.execPath, [bundle, ...args], {
    encoding: 'utf8',
    input,
    cwd,
    env: { ...process.env, REVIEW_VOICE_DATA_DIR: dataDir },
  });
  return { code: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

const candidate = (id, path, line, extra = {}) => ({
  candidate_id: id,
  path,
  line,
  category: 'correctness',
  severity: 'important',
  claim: `Claim ${id}.`,
  failure_mode: 'It fails.',
  evidence: ['Seen in the code.'],
  technical_confidence: 0.9,
  ...extra,
});
const verification = (ids) => ({
  verifications: ids.map((id) => ({ candidate_id: id, evidence_quality: 'high', technical_confidence: 0.92 })),
});

function withRepo(fn) {
  const base = mkdtempSync(join(tmpdir(), 'rv-carry-gaps-'));
  const repo = join(base, 'repo');
  const dataDir = join(base, 'data');
  const work = join(base, 'work');
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  const write = (name, body) => writeFileSync(join(repo, name), body);
  const commit = (message) => {
    git('add', '-A');
    git('commit', '-q', '-m', message);
    return git('rev-parse', 'HEAD');
  };
  try {
    mkdirSync(repo, { recursive: true });
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(work, { recursive: true });
    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    git('config', 'commit.gpgsign', 'false');
    write('a.ts', lines(40));
    write('b.ts', lines(10));
    write('c.ts', lines(10));
    const since = commit('verified head');
    const file = (name, value) => {
      const path = join(work, name);
      writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value));
      return path;
    };
    const carry = (head, candidates, verified, extra = []) =>
      run(
        ['carry-candidates', '--candidates', file('candidates.json', candidates), '--verification', file('verification.json', verified),
          '--since', since, '--head', head, '--diff-file', join(work, 'diff.patch'), '--out', join(work, 'next'), ...extra],
        { cwd: repo, dataDir },
      );
    const out = (name) => JSON.parse(readFileSync(join(work, 'next', name), 'utf8'));
    return fn({ repo, dataDir, work, write, commit, since, file, carry, out });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

/** An interdiff `diff --out` directory: the manifest and the patch of the commits since. */
function interdiffDir(work, { head, since, patch, kind = 'interdiff' }) {
  const dir = join(work, 'interdiff');
  mkdirSync(dir, { recursive: true });
  const scope =
    kind === 'full'
      ? { kind, cause: 'requested', since: null, priorRunId: null }
      : { kind, since, priorRunId: null, priorReviewedAt: null, mergeBase: since, files: [], hunks: 1 };
  writeFileSync(join(dir, 'files.json'), JSON.stringify({ mode: 'pull-request', head, scope }));
  writeFileSync(join(dir, 'diff.patch'), patch);
  return dir;
}

test('a guard added above an anchored line refuses the candidate, though its lines are untouched', () => {
  withRepo(({ write, commit, work, carry }) => {
    // The claim at line 30 is a null dereference; the push adds a guard at 22.
    const body = lines(40).replace('line 22\n', 'if (value === null) return;\nline 22\n');
    write('a.ts', body);
    const head = commit('add a guard');
    writeFileSync(join(work, 'diff.patch'), newFileDiff('a.ts', body));
    const result = carry(head, { candidates: [candidate('cand_001', 'a.ts', 30, { claim: 'value may be null here.' })] }, verification(['cand_001']));
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Refused cand_001: a\.ts changed between the two heads/);
  });
});

test('a candidate whose evidence or verification names a changed file is refused', () => {
  withRepo(({ write, commit, work, carry, out }) => {
    write('b.ts', lines(10).replace('line 4\n', 'line 4 changed\n'));
    const head = commit('change a file the evidence read');
    writeFileSync(join(work, 'diff.patch'), newFileDiff('a.ts', lines(40)));
    const verified = verification(['cand_001', 'cand_002', 'cand_003']);
    verified.verifications[2].traced = ['caller in src/b.ts:4'];
    const result = carry(
      head,
      {
        candidates: [
          candidate('cand_001', 'a.ts', 10, { evidence: ['The caller at b.ts:4 passes null.'] }),
          candidate('cand_002', 'a.ts', 20),
          candidate('cand_003', 'a.ts', 30),
        ],
      },
      verified,
    );
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Refused cand_001: its claim, evidence or verification names b\.ts/);
    assert.match(result.stderr, /Refused cand_003: its claim, evidence or verification names b\.ts/);
    assert.deepEqual(out('candidates.json').candidates.map((c) => c.candidate_id), ['cand_002']);
  });
});

test('the interdiff review is merged in, with clashing ids renamed in both files', () => {
  withRepo(({ write, commit, work, since, file, carry, out }) => {
    write('c.ts', `${lines(10)}line 11\n`);
    const head = commit('new commit');
    writeFileSync(join(work, 'diff.patch'), newFileDiff('a.ts', lines(40)) + newFileDiff('c.ts', `${lines(10)}line 11\n`));
    const patch = ['diff --git a/c.ts b/c.ts', '--- a/c.ts', '+++ b/c.ts', '@@ -10,0 +11,1 @@', '+line 11', ''].join('\n');
    const dir = interdiffDir(work, { head, since, patch });
    const extra = [
      '--interdiff', dir,
      '--interdiff-candidates', file('i-candidates.json', { candidates: [candidate('cand_001', 'c.ts', 11)] }),
      '--interdiff-verification', file('i-verification.json', verification(['cand_001'])),
    ];
    const result = carry(head, { candidates: [candidate('cand_001', 'a.ts', 20)] }, verification(['cand_001']), extra);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(out('candidates.json').candidates.map((c) => [c.candidate_id, c.path]), [
      ['cand_001', 'a.ts'],
      ['cand_001_interdiff', 'c.ts'],
    ]);
    assert.deepEqual(out('verification.json').verifications.map((v) => v.candidate_id), ['cand_001', 'cand_001_interdiff']);
    const record = out('carry.json');
    assert.equal(record.interdiff.reviewed, true);
    assert.deepEqual(record.interdiff.renamed, { cand_001: 'cand_001_interdiff' });
  });
});

test('an interdiff of another range, or a candidate off its patch, is refused', () => {
  withRepo(({ write, commit, work, file, carry }) => {
    write('c.ts', `${lines(10)}line 11\n`);
    const head = commit('new commit');
    writeFileSync(join(work, 'diff.patch'), newFileDiff('a.ts', lines(40)));
    const patch = ['diff --git a/c.ts b/c.ts', '--- a/c.ts', '+++ b/c.ts', '@@ -10,0 +11,1 @@', '+line 11', ''].join('\n');
    const args = (dir, line) => [
      '--interdiff', dir,
      '--interdiff-candidates', file('i-candidates.json', { candidates: [candidate('cand_009', 'c.ts', line)] }),
      '--interdiff-verification', file('i-verification.json', verification(['cand_009'])),
    ];
    const old = { candidates: [candidate('cand_001', 'a.ts', 20)] };

    const wrongRange = carry(head, old, verification(['cand_001']), args(interdiffDir(work, { head, since: 'f'.repeat(40), patch }), 11));
    assert.equal(wrongRange.code, 2);
    assert.match(wrongRange.stderr, /covers the commits since/);

    const offPatch = carry(head, old, verification(['cand_001']), args(interdiffDir(work, { head, since: 'x', patch, kind: 'full' }), 3));
    assert.equal(offPatch.code, 2);
    assert.match(offPatch.stderr, /not on a changed line/);

    const partial = carry(head, old, verification(['cand_001']), ['--interdiff', join(work, 'interdiff')]);
    assert.equal(partial.code, 2);
  });
});

test('held findings move to the new head, and those on changed code are dropped', () => {
  withRepo(({ write, commit, work, file, carry, out }) => {
    write('b.ts', lines(10).replace('line 4\n', 'line 4 changed\n'));
    write('c.ts', `new top\n${lines(10)}`);
    const head = commit('push');
    writeFileSync(join(work, 'diff.patch'), newFileDiff('a.ts', lines(40)));
    const held = file('held.json', [
      { path: 'a.ts', line: 5, verdict: 'refuted', source: 'verifier', reason: 'not reachable' },
      { path: 'b.ts', line: 4, verdict: 'repeat', source: 'thread', reason: 'already said' },
      { path: 'c.ts', line: 8, verdict: 'partly', source: 'cross-check', reason: 'half right' },
    ]);
    const result = carry(head, { candidates: [candidate('cand_001', 'a.ts', 20)] }, verification(['cand_001']), ['--held', held]);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(out('held.json').map((h) => [h.path, h.line]), [['a.ts', 5], ['c.ts', 9]]);
    assert.match(result.stderr, /Held finding dropped: b\.ts:4/);
  });
});

/** A fake GitHub on which the head has not moved and CI is green. */
function greenGitHub(head) {
  const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  const impl = async (url) => {
    const path = new URL(String(url)).pathname;
    if (/\/pulls\/\d+$/.test(path)) return json({ head: { sha: head } });
    if (path.endsWith('/check-runs')) {
      return json({ total_count: 1, check_runs: [{ id: 1, name: 'build', status: 'completed', conclusion: 'success', completed_at: '2026-10-01T10:00:00Z' }] });
    }
    if (path.endsWith('/status')) return json({ state: 'success', total_count: 0, statuses: [] });
    return new Response('not found', { status: 404 });
  };
  return new GitHubClient({ allowlist: ['acme/web'], token: 't', fetchImpl: impl, sleep: async () => {} });
}

test('a run recorded from a carry without the interdiff review never approves', async () => {
  const head = 'c'.repeat(40);
  const dir = mkdtempSync(join(tmpdir(), 'rv-carry-verdict-'));
  const db = openDatabase(join(dir, 'review-voice.db'));
  try {
    const marker = (covered) => ({ since: 'a'.repeat(40), head, interdiffReviewed: covered, refused: [], covered });
    const verdictFor = async (carry) => {
      const { reviewRunId } = recordRun(db, {
        repository: 'acme/web', baseRef: null, headRef: head, pullNumber: 7, diff: 'd', output: 'No actionable findings.', scores: [],
        complexity: { level: 'normal', decisionPoints: 0, sensitivePaths: [], reasons: [] },
        ...(carry === undefined ? {} : { carry }),
      });
      return computeVerdict({ db, client: greenGitHub(head), repository: 'acme/web', pullNumber: 7, head, review: 'No actionable findings.', runId: reviewRunId });
    };

    const uncovered = await verdictFor(marker(false));
    assert.equal(uncovered.output.event, 'COMMENT');
    assert.ok(uncovered.output.reasons.some((r) => /carried to this head without a review of the commits since/.test(r)));
    // The reason is local: the posted body does not mention the carry.
    assert.doesNotMatch(JSON.stringify(uncovered.output.payload), /carr/i);

    const covered = await verdictFor(marker(true));
    assert.equal(covered.output.event, 'APPROVE');

    assert.equal(decide({ mapped: 'APPROVE', headMoved: false, ci: 'green', recheck: true, uncoveredCarry: true }).exitCode, 2);
    assert.equal(decide({ mapped: 'REQUEST_CHANGES', headMoved: false, ci: 'green', recheck: false, uncoveredCarry: true }).event, 'REQUEST_CHANGES');
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('record --carry stores the marker, and a findings carry from that run inherits it', () => {
  withRepo(({ repo, dataDir, write, commit, work, file, carry }) => {
    write('c.ts', `${lines(10)}line 11\n`);
    const head = commit('push');
    writeFileSync(join(work, 'diff.patch'), newFileDiff('a.ts', lines(40)));
    assert.equal(carry(head, { candidates: [candidate('cand_001', 'a.ts', 20)] }, verification(['cand_001'])).code, 0);
    const carryJson = join(work, 'next', 'carry.json');

    const wrongHead = run(['record', '--head', 'd'.repeat(40), '--carry', carryJson], { cwd: repo, dataDir, input: 'No actionable findings.\n' });
    assert.equal(wrongHead.code, 2);

    const recorded = run(['record', '--repository', 'acme/web', '--head', head, '--carry', carryJson], {
      cwd: repo, dataDir, input: 'No actionable findings.\n',
    });
    assert.equal(recorded.code, 0, recorded.stderr);
    const runId = JSON.parse(recorded.stdout).reviewRunId;

    write('d.ts', 'rebase stand-in\n');
    const next = commit('rebase stand-in');
    const again = run(['record', '--repository', 'acme/web', '--head', next, '--carried-from', runId], {
      cwd: repo, dataDir, input: 'No actionable findings.\n',
    });
    assert.equal(again.code, 0, again.stderr);

    const db = openDatabase(databasePath({ REVIEW_VOICE_DATA_DIR: dataDir }));
    try {
      const first = runDetail(db, runId);
      assert.equal(first.carry.covered, false);
      assert.equal(first.carry.interdiffReviewed, false);
      const inherited = runDetail(db, JSON.parse(again.stdout).reviewRunId);
      assert.equal(inherited.carry.covered, false);
      assert.equal(inherited.carry.inheritedFrom, runId);
    } finally {
      db.close();
    }
  });
});

test('carry --text and record --carried-from refuse when an important finding did not carry', () => {
  withRepo(({ repo, dataDir, write, commit, since }) => {
    const review =
      '[important] `a.ts:20` - The loop never ends. The request hangs. Break on the sentinel.\n\n' +
      '[minor] `b.ts:5` - The name shadows the import. Readers confuse them. Rename it.\n';
    const recorded = run(['record', '--repository', 'o/r', '--head', since], { cwd: repo, dataDir, input: review });
    assert.equal(recorded.code, 0, recorded.stderr);
    const runId = JSON.parse(recorded.stdout).reviewRunId;
    write('a.ts', lines(40).replace('line 20\n', 'changed\n'));
    const head = commit('touch the important one');

    const text = run(['carry', '--from', runId, '--head', head, '--text'], { cwd: repo, dataDir });
    assert.equal(text.code, 1);
    assert.equal(text.stdout, '');
    assert.match(text.stderr, /rv_01 \(important\)/);

    const carried = '[minor] `b.ts:5` - The name shadows the import. Readers confuse them. Rename it.\n';
    const stored = run(['record', '--repository', 'o/r', '--head', head, '--carried-from', runId], { cwd: repo, dataDir, input: carried });
    assert.equal(stored.code, 2);
    assert.match(stored.stderr, /rv_01 \(important, a\.ts:20\)/);
  });
});

test('reanchor leaves both files as they were when one cannot be written', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rv-reanchor-atomic-'));
  const locked = join(dir, 'locked');
  try {
    mkdirSync(locked);
    const patch = join(dir, 'diff.patch');
    writeFileSync(patch, newFileDiff('a.ts', lines(5)));
    const scores = join(dir, 'scores.json');
    const before = JSON.stringify({
      scores: [{ candidateId: 'cand_001', path: 'a.ts', line: 3, eligible: true, finalScore: 0.8 }],
      eligible: [{ candidateId: 'cand_001', path: 'a.ts', line: 3, severity: 'nit' }],
    });
    writeFileSync(scores, before);
    const candidates = join(locked, 'candidates.json');
    writeFileSync(candidates, JSON.stringify({ candidates: [{ candidate_id: 'cand_001', path: 'a.ts', line: 3 }] }));
    chmodSync(locked, 0o500);

    const result = run(
      ['reanchor', '--candidate', 'cand_001', '--line', '2', '--scores', scores, '--diff-file', patch, '--candidates', candidates],
      { cwd: dir, dataDir: dir },
    );
    assert.notEqual(result.code, 0);
    assert.equal(readFileSync(scores, 'utf8'), before);
    assert.deepEqual(readdirSync(dir).filter((name) => name.includes('reanchor-')), []);
  } finally {
    chmodSync(locked, 0o700);
    rmSync(dir, { recursive: true, force: true });
  }
});
