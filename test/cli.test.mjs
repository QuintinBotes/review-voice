import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bundle = join(root, 'plugins/review-voice/dist/review-voice.mjs');

function run(args) {
  try {
    const stdout = execFileSync(process.execPath, [bundle, ...args], { encoding: 'utf8' });
    return { code: 0, stdout };
  } catch (error) {
    return { code: error.status, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

/**
 * Runs with stdin and an isolated data directory, so a test can never open the
 * user's own corpus.
 */
function runWithInput(args, input, dataDir) {
  try {
    const stdout = execFileSync(process.execPath, [bundle, ...args], {
      encoding: 'utf8',
      input,
      env: { ...process.env, REVIEW_VOICE_DATA_DIR: dataDir },
    });
    return { code: 0, stdout, stderr: '' };
  } catch (error) {
    return { code: error.status, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

test('--version matches the plugin manifest', () => {
  const manifest = JSON.parse(
    readFileSync(join(root, 'plugins/review-voice/.claude-plugin/plugin.json'), 'utf8'),
  );
  const { code, stdout } = run(['--version']);
  assert.equal(code, 0);
  assert.equal(stdout.trim(), manifest.version);
});

test('the marketplace entry and the plugin manifest agree on version', () => {
  const manifest = JSON.parse(
    readFileSync(join(root, 'plugins/review-voice/.claude-plugin/plugin.json'), 'utf8'),
  );
  const marketplace = JSON.parse(
    readFileSync(join(root, '.claude-plugin/marketplace.json'), 'utf8'),
  );
  const entry = marketplace.plugins.find((p) => p.name === 'review-voice');
  assert.ok(entry, 'marketplace.json must list the review-voice plugin');
  assert.equal(entry.version, manifest.version);
});

test('doctor reports the required tooling and succeeds on a supported machine', () => {
  const { code, stdout } = run(['doctor']);
  assert.match(stdout, /node:sqlite/);
  assert.match(stdout, /\bgit\b/);
  assert.equal(code, 0, 'doctor should pass on a machine that can run the test suite');
});

test('no output leaks the node:sqlite experimental warning', () => {
  const { stdout, stderr = '' } = run(['doctor']);
  assert.doesNotMatch(stdout + stderr, /ExperimentalWarning/);
});

test('an unknown command fails loudly rather than silently', () => {
  const { code, stderr } = run(['definitely-not-a-command']);
  assert.equal(code, 2);
  assert.match(stderr, /Unknown command/);
});

test('--help does not require any runtime dependency to be installed', () => {
  const { code, stdout } = run(['--help']);
  assert.equal(code, 0);
  assert.match(stdout, /review-voice <command>/);
});

// The verification file the agent actually writes (NEW-01)

const CANDIDATE = JSON.stringify({
  candidates: [
    {
      candidate_id: 'cand_003',
      path: 'src/a.ts',
      line: 12,
      category: 'correctness',
      severity: 'important',
      claim: 'The handler returns before the transaction commits.',
      failure_mode: 'A retry creates two records.',
      evidence: ['Transaction opens at line 8.', 'Return happens at line 12.', 'Commit runs at line 19.'],
      technical_confidence: 0.75,
    },
  ],
});

test('score reads the key the evidence-verifier actually emits', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rv-verify-'));
  try {
    // `results` is what the agent emits. It was not an accepted key, so every
    // candidate silently fell back to the analyst's self-report and the
    // command still exited 0, which made this release's headline fix inert on
    // its own documented pipeline.
    for (const key of ['results', 'verifications', 'verdicts']) {
      const file = join(dir, `${key}.json`);
      writeFileSync(
        file,
        JSON.stringify({
          [key]: [{ candidate_id: 'cand_003', evidence_quality: 'high', technical_confidence: 0.85 }],
        }),
      );

      const { code, stdout, stderr } = runWithInput(['score', '--verification', file], CANDIDATE, dir);
      assert.equal(code, 0, stderr);
      const parsed = JSON.parse(stdout);
      assert.equal(parsed.scores[0].confidenceSource, 'verifier', `key ${key} was not read`);
      assert.equal(parsed.scores[0].verifiedConfidence, 0.85);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a verification file that yields nothing is an error, not a silent fallback', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rv-verify-'));
  try {
    const file = join(dir, 'empty.json');
    writeFileSync(file, JSON.stringify({ somethingElse: [{ candidate_id: 'cand_003' }] }));

    const { code, stderr } = runWithInput(['score', '--verification', file], CANDIDATE, dir);
    assert.equal(code, 2);
    assert.match(stderr, /contained no verifications/);
    assert.match(stderr, /Refusing to score on the analyst self-report/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('score reports the distribution it produced, so the threshold can be checked', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rv-verify-'));
  try {
    const { code, stdout } = runWithInput(['score'], CANDIDATE, dir);
    assert.equal(code, 0);
    const { distribution } = JSON.parse(stdout);
    assert.equal(distribution.count, 1);
    assert.equal(distribution.threshold, 0.68);
    assert.equal(typeof distribution.median, 'number');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('conventions --help prints help instead of dumping every document', () => {
  // It executed with repository-wide defaults and wrote 82 KB to stdout.
  const { code, stdout } = run(['conventions', '--help']);
  assert.equal(code, 0);
  assert.match(stdout, /review-voice <command>/);
  assert.ok(stdout.length < 8_000, `help should be help, got ${stdout.length} bytes`);
});
