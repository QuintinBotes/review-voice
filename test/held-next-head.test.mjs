import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bundle = join(root, 'plugins/review-voice/dist/review-voice.mjs');

const lines = (n) => Array.from({ length: n }, (_, i) => `line ${i + 1}\n`).join('');

const CLAIM = 'The cache key omits the tenant, so one tenant can read the entries of another.';
const FAILURE = 'A shared key returns cached data across tenants after a lookup.';

function run(args, { input = '', cwd, dataDir }) {
  const r = spawnSync(process.execPath, [bundle, ...args], {
    encoding: 'utf8',
    input,
    cwd,
    env: { ...process.env, REVIEW_VOICE_DATA_DIR: dataDir },
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

const candidate = (over = {}) => ({
  candidate_id: 'c1',
  path: 'a.ts',
  line: 20,
  category: 'correctness',
  severity: 'important',
  claim: CLAIM,
  failure_mode: FAILURE,
  evidence: ['The key is built on the changed line.'],
  technical_confidence: 0.9,
  ...over,
});

/** A repository with a run recorded at the first head, holding the given entries. */
function withHeld(held, fn) {
  const base = mkdtempSync(join(tmpdir(), 'rv-held-next-'));
  const repo = join(base, 'repo');
  const dataDir = join(base, 'data');
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  const commit = (message) => {
    git('add', '-A');
    git('commit', '-q', '-m', message);
    return git('rev-parse', 'HEAD');
  };
  const write = (name, body) => writeFileSync(join(repo, name), body);
  try {
    execFileSync('mkdir', ['-p', repo, dataDir]);
    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    git('config', 'commit.gpgsign', 'false');
    write('a.ts', lines(40));
    const prior = commit('first');
    const heldFile = join(base, 'held.json');
    writeFileSync(heldFile, JSON.stringify(held));
    const recorded = run(['record', '--repository', 'o/r', '--head', prior, '--held', heldFile], {
      input: '[minor] `a.ts:5` - an unrelated note.\n',
      cwd: repo,
      dataDir,
    });
    assert.equal(recorded.code, 0, recorded.stderr);
    const runId = JSON.parse(recorded.stdout).reviewRunId;

    // The diff is only here so the anchors pass; every line is added.
    const patch = join(base, 'diff.patch');
    const body = Array.from({ length: 40 }, (_, i) => `+line ${i + 1}`);
    writeFileSync(patch, ['diff --git a/a.ts b/a.ts', '--- /dev/null', '+++ b/a.ts', '@@ -0,0 +1,40 @@', ...body].join('\n'));

    const check = (head, args = ['--held-from', runId, '--head', head], candidates = [candidate()]) =>
      run(['check-candidates', '--diff-file', patch, ...args], { input: JSON.stringify({ candidates }), cwd: repo, dataDir });
    return fn({ write, commit, check, runId });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

const entry = (over = {}) => ({
  path: 'a.ts',
  line: 21,
  verdict: 'refuted',
  source: 'verifier',
  reason: 'the key is namespaced upstream',
  text: CLAIM,
  ...over,
});

test('a refuted held finding on unchanged code drops the same candidate at the next head', () => {
  withHeld([entry()], ({ write, commit, check, runId }) => {
    write('b.ts', 'unrelated\n');
    const head = commit('unrelated change');
    const r = check(head);
    assert.equal(r.code, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.deepEqual(out.kept, []);
    assert.equal(out.droppedAsHeld.length, 1);
    assert.deepEqual(out.droppedAsHeld[0], {
      candidateId: 'c1',
      path: 'a.ts',
      line: 20,
      heldVerdict: 'refuted',
      heldReason: 'the key is namespaced upstream',
      priorRunId: runId,
    });
  });
});

test('a held finding whose code changed within two lines is not consulted', () => {
  withHeld([entry()], ({ write, commit, check }) => {
    write('a.ts', lines(40).replace('line 22\n', 'changed\n'));
    const out = JSON.parse(check(commit('edit near')).stdout);
    assert.equal(out.kept.length, 1);
    assert.equal(out.droppedAsHeld.length, 0);
    assert.equal(out.kept[0].possibleRepeatOf, undefined);
  });
});

test('unrelated wording on the same line is kept and marked as a possible held repeat', () => {
  withHeld([entry({ text: 'The loop index starts at one, which skips the first element of the list.' })], ({ commit, write, check }) => {
    write('b.ts', 'unrelated\n');
    const out = JSON.parse(check(commit('unrelated change')).stdout);
    assert.equal(out.droppedAsHeld.length, 0);
    assert.equal(out.kept.length, 1);
    assert.equal(out.kept[0].possibleRepeatOf.kind, 'held');
    assert.equal(out.kept[0].possibleRepeatOf.verdict, 'refuted');
    assert.equal(out.kept[0].possibleRepeatOf.reason, 'the key is namespaced upstream');
  });
});

test('a held finding without text is kept and marked for the verifier', () => {
  withHeld([entry({ text: undefined, verdict: 'partly' })], ({ commit, write, check }) => {
    write('b.ts', 'unrelated\n');
    const out = JSON.parse(check(commit('unrelated change')).stdout);
    assert.equal(out.kept[0].possibleRepeatOf.kind, 'held');
    assert.equal(out.kept[0].possibleRepeatOf.verdict, 'partly');
  });
});

test('an unverified held finding is not consulted', () => {
  withHeld([entry({ verdict: 'unverified' })], ({ commit, write, check }) => {
    write('b.ts', 'unrelated\n');
    const out = JSON.parse(check(commit('unrelated change')).stdout);
    assert.equal(out.kept.length, 1);
    assert.equal(out.droppedAsHeld.length, 0);
    assert.equal(out.kept[0].possibleRepeatOf, undefined);
  });
});

test('an unknown run id keeps every candidate and says held findings were not consulted', () => {
  withHeld([entry()], ({ commit, write, check }) => {
    write('b.ts', 'unrelated\n');
    const r = check(commit('unrelated change'), ['--held-from', 'rv_run_missing', '--head', 'HEAD']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stderr, /Held findings were not consulted/);
    const out = JSON.parse(r.stdout);
    assert.equal(out.kept.length, 1);
    assert.equal(out.droppedAsHeld.length, 0);
  });
});

test('--held-from without --head exits 2', () => {
  withHeld([entry()], ({ check, runId }) => {
    const r = check('unused', ['--held-from', runId]);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /--head/);
  });
});
