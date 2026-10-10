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

const HELD_TEXT = 'The label changes are not behind the feature flag, so they ship to every customer at once.';
const CLAIM = 'The new label changes are not behind the feature flag and ship to every customer at once.';

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
  path: 'src/labels/messages.ts',
  line: 30,
  category: 'correctness',
  severity: 'nit',
  claim: CLAIM,
  failure_mode: 'Customers see the new labels before the flag is switched on.',
  evidence: ['The labels in src/labels/strings.ts are changed without a flag check.'],
  technical_confidence: 0.9,
  ...over,
});

const entry = (over = {}) => ({
  path: 'src/labels/strings.ts',
  line: 10,
  verdict: 'refuted',
  source: 'verifier',
  reason: 'the flag is applied by the caller',
  text: HELD_TEXT,
  ...over,
});

/** A repository with a run recorded at the first head, holding the given entries. */
function withHeld(held, fn) {
  const base = mkdtempSync(join(tmpdir(), 'rv-issue-83-'));
  const repo = join(base, 'repo');
  const dataDir = join(base, 'data');
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  try {
    execFileSync('mkdir', ['-p', join(repo, 'src/labels'), dataDir]);
    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    git('config', 'commit.gpgsign', 'false');
    writeFileSync(join(repo, 'src/labels/strings.ts'), lines(40));
    writeFileSync(join(repo, 'src/labels/messages.ts'), lines(40));
    git('add', '-A');
    git('commit', '-q', '-m', 'first');
    const prior = git('rev-parse', 'HEAD');
    const heldFile = join(base, 'held.json');
    writeFileSync(heldFile, JSON.stringify(held));
    const recorded = run(['record', '--repository', 'o/r', '--head', prior, '--held', heldFile], {
      input: '[minor] `src/labels/strings.ts:5` - an unrelated note.\n',
      cwd: repo,
      dataDir,
    });
    assert.equal(recorded.code, 0, recorded.stderr);
    const runId = JSON.parse(recorded.stdout).reviewRunId;

    const patch = join(base, 'diff.patch');
    const diff = (file) => [
      `diff --git a/${file} b/${file}`,
      '--- /dev/null',
      `+++ b/${file}`,
      '@@ -0,0 +1,40 @@',
      ...Array.from({ length: 40 }, (_, i) => `+line ${i + 1}`),
    ];
    writeFileSync(patch, [...diff('src/labels/strings.ts'), ...diff('src/labels/messages.ts')].join('\n'));

    const check = (candidates = [candidate()]) => {
      writeFileSync(join(repo, 'unrelated.txt'), 'unrelated\n');
      git('add', '-A');
      git('commit', '-q', '-m', 'unrelated change');
      const head = git('rev-parse', 'HEAD');
      return run(['check-candidates', '--diff-file', patch, '--held-from', runId, '--head', head], {
        input: JSON.stringify({ candidates }),
        cwd: repo,
        dataDir,
      });
    };
    return fn({ check });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

test('a refuted concern re-raised at another anchor that names the held file is kept and marked with its path and line', () => {
  withHeld([entry()], ({ check }) => {
    const r = check();
    assert.equal(r.code, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.droppedAsHeld.length, 0);
    assert.equal(out.kept.length, 1);
    const mark = out.kept[0].possibleRepeatOf;
    assert.equal(mark.kind, 'held');
    assert.equal(mark.verdict, 'refuted');
    assert.equal(mark.reason, 'the flag is applied by the caller');
    assert.equal(mark.path, 'src/labels/strings.ts');
    assert.equal(mark.line, 10);
    assert.match(mark.excerpt, /feature flag/);
  });
});

test('the held file is recognised by its distinctive basename', () => {
  withHeld([entry()], ({ check }) => {
    const out = JSON.parse(check([candidate({ evidence: ['strings.ts changes the same labels with no flag check.'] })]).stdout);
    assert.equal(out.kept[0].possibleRepeatOf.kind, 'held');
  });
});

test('a candidate at another anchor that does not name the held file is not marked', () => {
  withHeld([entry()], ({ check }) => {
    const out = JSON.parse(check([candidate({ evidence: ['The labels are changed without a flag check.'] })]).stdout);
    assert.equal(out.kept.length, 1);
    assert.equal(out.kept[0].possibleRepeatOf, undefined);
  });
});

test('naming the held file but saying something else is not marked', () => {
  withHeld([entry()], ({ check }) => {
    const out = JSON.parse(
      check([
        candidate({
          claim: 'The loop index starts at one, which skips the first element of the list.',
          failure_mode: 'The first element is never processed.',
        }),
      ]).stdout,
    );
    assert.equal(out.kept[0].possibleRepeatOf, undefined);
  });
});

test('a below-gate entry at the same anchor with matching wording is kept and marked, not dropped', () => {
  withHeld([entry({ verdict: 'below-gate', path: 'src/labels/messages.ts', line: 30, reason: 'confidence under the gate' })], ({ check }) => {
    const out = JSON.parse(check().stdout);
    assert.equal(out.droppedAsHeld.length, 0);
    assert.equal(out.kept.length, 1);
    const mark = out.kept[0].possibleRepeatOf;
    assert.equal(mark.kind, 'held');
    assert.equal(mark.verdict, 'below-gate');
    assert.equal(mark.path, 'src/labels/messages.ts');
    assert.equal(mark.line, 30);
  });
});

test('a below-gate entry at another anchor is marked, never dropped', () => {
  withHeld([entry({ verdict: 'below-gate' })], ({ check }) => {
    const out = JSON.parse(check().stdout);
    assert.equal(out.droppedAsHeld.length, 0);
    assert.equal(out.kept[0].possibleRepeatOf.verdict, 'below-gate');
  });
});

test('a refuted entry at the same anchor with matching wording still drops', () => {
  withHeld([entry({ path: 'src/labels/messages.ts', line: 30 })], ({ check }) => {
    const out = JSON.parse(check().stdout);
    assert.deepEqual(out.kept, []);
    assert.equal(out.droppedAsHeld.length, 1);
    assert.equal(out.droppedAsHeld[0].heldVerdict, 'refuted');
  });
});
