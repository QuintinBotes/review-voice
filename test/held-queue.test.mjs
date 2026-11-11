/**
 * The held queue (S22 part B, docs/adr/0031 amendment): `verdict.held_queue`
 * lists every finding a run held, with its verdict and reason, and the
 * `score --promote` command for the ones the owner can post, in the review
 * report, the job summary and the watcher report. Nothing about the verdict,
 * the posted review or the scope block's counts changes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../plugins/review-voice/src/store/db.ts';
import { HELD_VERDICTS, recordRun } from '../plugins/review-voice/src/store/runs.ts';
import { GitHubClient } from '../plugins/review-voice/src/github/client.ts';
import { loadConfig } from '../plugins/review-voice/src/policy/load.ts';
import { computeVerdict } from '../plugins/review-voice/src/publish/post.ts';
import { heldCounts, safeCheckName } from '../plugins/review-voice/src/publish/verdict.ts';
import { heldQueue, heldQueueLines, isHeldQueueEntry, PROMOTE_NOTE, writeJobSummary } from '../plugins/review-voice/src/review/held-queue.ts';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bundle = join(root, 'plugins/review-voice/dist/review-voice.mjs');
const temp = (t, prefix) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

const CALL = {
  program: ['/usr/bin/node', '/opt/rv/dist/review-voice.mjs'],
  cwd: '/work/repo',
  env: { REVIEW_VOICE_CONFIG: '/data/runs/r1/config.yaml', REVIEW_VOICE_DATA_DIR: '/data' },
  args: ['score', '--repository', 'acme/web', '--verification', '/data/runs/r1/verification.json', '--head', 'abc123'],
  stdin: '/data/runs/r1/score-input.json',
  stdout: '/data/runs/r1/scores.promoted.json',
};
const COMMAND =
  'cd /work/repo && REVIEW_VOICE_CONFIG=/data/runs/r1/config.yaml REVIEW_VOICE_DATA_DIR=/data /usr/bin/node /opt/rv/dist/review-voice.mjs ' +
  'score --repository acme/web --verification /data/runs/r1/verification.json --head abc123 --promote cand_001 ' +
  '< /data/runs/r1/score-input.json > /data/runs/r1/scores.promoted.json';

const held = (verdict, extra = {}) => ({
  path: 'src/held.ts',
  line: 4,
  verdict,
  source: 'score',
  reason: 'below the confidence gate',
  severity: 'minor',
  candidateId: 'cand_001',
  text: 'Local claim text.',
  ...extra,
});

// --- settings ---

function configFrom(t, yaml) {
  const dir = temp(t, 'rv-held-queue-config-');
  mkdirSync(join(dir, '.review-voice'));
  writeFileSync(join(dir, '.review-voice', 'config.yaml'), yaml);
  return loadConfig(dir);
}

test('config: verdict.held_queue is read, default false, and a bad value warns', (t) => {
  assert.equal(configFrom(t, 'verdict:\n  never_approve: false\n').verdictPolicy.heldQueue, false);
  const on = configFrom(t, 'verdict:\n  held_queue: true\n');
  assert.equal(on.verdictPolicy.heldQueue, true);
  assert.deepEqual(on.warnings, []);
  const bad = configFrom(t, 'verdict:\n  held_queue: maybe\n');
  assert.equal(bad.verdictPolicy.heldQueue, false);
  assert.deepEqual(bad.warnings, ['verdict.held_queue must be true or false; using false.']);
});

test('context prints heldQueue from the configuration', (t) => {
  const context = (yaml) => {
    const dir = temp(t, 'rv-held-queue-context-');
    execFileSync('git', ['init', '-q'], { cwd: dir });
    if (yaml !== null) {
      mkdirSync(join(dir, '.review-voice'));
      writeFileSync(join(dir, '.review-voice', 'config.yaml'), yaml);
    }
    const env = { ...process.env, REVIEW_VOICE_DATA_DIR: join(dir, 'data') };
    delete env.REVIEW_VOICE_CONFIG;
    const run = spawnSync(process.execPath, [bundle, 'context'], { cwd: dir, encoding: 'utf8', env });
    assert.equal(run.status, 0, run.stderr);
    return JSON.parse(run.stdout);
  };
  assert.equal(context('verdict:\n  held_queue: true\n').heldQueue, true);
  assert.equal(context(null).heldQueue, false);
});

// --- entries ---

test('heldQueue sets promote only for below-gate and policy-suppressed entries with a candidate id and a call', () => {
  for (const verdict of HELD_VERDICTS) {
    const [entry] = heldQueue([held(verdict)], CALL);
    const promotable = verdict === 'below-gate' || verdict === 'policy-suppressed';
    assert.equal(entry.promote, promotable ? COMMAND : null, verdict);
    assert.equal(entry.verdict, verdict);
  }
  const [entry] = heldQueue([held('below-gate')], CALL);
  assert.deepEqual(entry, {
    path: 'src/held.ts',
    line: 4,
    severity: 'minor',
    verdict: 'below-gate',
    reason: 'below the confidence gate',
    candidateId: 'cand_001',
    promote: COMMAND,
  });
  assert.ok(!('text' in entry), 'no claim text in the list');
  for (const verdict of ['below-gate', 'policy-suppressed']) {
    assert.equal(heldQueue([held(verdict)], null)[0].promote, null, `${verdict} without a call`);
    for (const candidateId of [undefined, '']) {
      const [none] = heldQueue([held(verdict, { candidateId })], CALL);
      assert.equal(none.promote, null, `${verdict} without a candidate id`);
      assert.equal(none.candidateId, null);
    }
  }
  assert.equal(heldQueue([held('below-gate', { severity: undefined })], CALL)[0].severity, null);
});

test('heldQueue: a word with a backtick or a control character gives no command', () => {
  const words = ['/work/`id`', '/work/a\nb', '/work/a\u0007b', '/work/a‮b'];
  for (const cwd of words) assert.equal(heldQueue([held('below-gate')], { ...CALL, cwd })[0].promote, null, JSON.stringify(cwd));
  assert.equal(heldQueue([held('below-gate', { candidateId: 'cand_`x`' })], CALL)[0].promote, null);
  assert.equal(heldQueue([held('below-gate')], { ...CALL, env: { REVIEW_VOICE_CONFIG: '/c\r.yaml' } })[0].promote, null);
});

test('heldQueue: a word with a space or a quote is single-quoted, and a POSIX shell reads every word back', (t) => {
  const dir = temp(t, "rv-held-queue-it's a dir-");
  const input = join(dir, 'score input.json');
  writeFileSync(input, '');
  const output = join(dir, 'out.txt');
  const words = ["it's", 'a b', '$HOME', '*', '"q"', 'a;b'];
  const call = { program: ['printf', '%s\\n'], cwd: dir, env: {}, args: words, stdin: input, stdout: output };
  const [entry] = heldQueue([held('below-gate')], call);
  assert.ok(entry.promote.startsWith(`cd '${dir.replaceAll("'", "'\\''")}' && printf '%s\\n' 'it'\\''s' 'a b' '$HOME' '*'`), entry.promote);
  const run = spawnSync('sh', ['-c', entry.promote], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(readFileSync(output, 'utf8').split('\n'), [...words, '--promote', 'cand_001', '']);
});

test('heldQueue maps every entry in order, one to one', () => {
  const entries = HELD_VERDICTS.map((verdict, index) => held(verdict, { line: index + 1 }));
  const queue = heldQueue(entries, CALL);
  assert.deepEqual(queue.map((entry) => [entry.verdict, entry.line]), entries.map((entry) => [entry.verdict, entry.line]));
  assert.ok(queue.every(isHeldQueueEntry));
});

// --- rendering ---

test('heldQueueLines returns nothing for an empty list, and a heading, the note and one line per entry otherwise', () => {
  assert.deepEqual(heldQueueLines([], 'run-1'), []);
  const queue = heldQueue([held('below-gate'), held('unverified', { candidateId: 'cand_002', reason: 'could not check: the caller' })], CALL);
  assert.deepEqual(heldQueueLines(queue, 'run-1'), [
    'Held by Review Voice (2), run `run-1`',
    PROMOTE_NOTE,
    `- \`src/held.ts:4\`, \`minor\`, \`below-gate\`, \`below the confidence gate\`. Promote with \`${COMMAND}\`.`,
    '- `src/held.ts:4`, `minor`, `unverified`, `could not check: the caller`. Not promotable.',
  ]);
  // No call, as inside GitHub Actions: a promotable entry is named by its candidate id alone.
  assert.deepEqual(heldQueueLines(heldQueue([held('policy-suppressed')], null), null).slice(2), [
    '- `src/held.ts:4`, `minor`, `policy-suppressed`, `below the confidence gate`. Promotable as `cand_001`.',
  ]);
});

test('heldQueueLines: hostile paths and reasons stay on one line, inside code spans', () => {
  const hostile = {
    path: 'src/`a`\n<details><summary>x</summary>.ts',
    reason: 'see `this`\n\n<details>@someone [link](https://example.com)',
    severity: 'minor`\n',
    candidateId: 'cand_`1`',
  };
  const queue = [
    ...heldQueue([held('refuted', hostile)], CALL),
    // As a watcher could read it from another process: a promote that would break its span is not printed.
    { ...heldQueue([held('below-gate', hostile)], CALL)[0], promote: 'rm `x`\nnext' },
  ];
  const lines = heldQueueLines(queue, 'run`\n<b>');
  for (const line of lines) {
    assert.ok(!line.includes('\n'), line);
    assert.equal((line.match(/`/g) ?? []).length % 2, 0, line);
    // Everything outside a code span is text this module wrote, never a recorded string.
    assert.ok(!/[<@\[]/.test(line.replace(/`[^`]*`/g, '')), line);
  }
  assert.equal((lines[2].match(/`/g) ?? []).length, 8, 'four spans: location, severity, verdict, reason');
  assert.ok(lines[3].endsWith('Promotable as `cand_1`.'), lines[3]);
  assert.ok(lines[0].includes('`run <b>`'), lines[0]);
});

test('safeCheckName with one argument behaves as before', () => {
  assert.equal(safeCheckName('a `b`\n c'), 'a b c');
  const long = safeCheckName('x'.repeat(100));
  assert.equal([...long].length, 60);
  assert.ok(long.endsWith('…'));
  assert.equal([...safeCheckName('x'.repeat(300), 200)].length, 200);
});

// --- the job summary ---

test('writeJobSummary appends the heading and lines inside GitHub Actions, and nothing otherwise', (t) => {
  const dir = temp(t, 'rv-held-queue-summary-');
  const file = join(dir, 'summary.md');
  writeFileSync(file, 'before\n');
  const report = { runId: 'run-1', heldQueue: heldQueue([held('below-gate')], null) };
  const lines = heldQueueLines(report.heldQueue, 'run-1');
  assert.equal(writeJobSummary(report, { GITHUB_ACTIONS: 'true', GITHUB_STEP_SUMMARY: file }), null);
  assert.equal(readFileSync(file, 'utf8'), `before\n## ${lines[0]}\n\n${lines[1]}\n\n${lines[2]}\n\n`);

  const untouched = readFileSync(file, 'utf8');
  for (const [name, args] of [
    ['without GITHUB_ACTIONS', [report, { GITHUB_STEP_SUMMARY: file }]],
    ['with GITHUB_ACTIONS not true', [report, { GITHUB_ACTIONS: 'false', GITHUB_STEP_SUMMARY: file }]],
    ['without a summary file', [report, { GITHUB_ACTIONS: 'true' }]],
    ['with no queue', [{ runId: 'run-1' }, { GITHUB_ACTIONS: 'true', GITHUB_STEP_SUMMARY: file }]],
    ['with an empty queue', [{ runId: 'run-1', heldQueue: [] }, { GITHUB_ACTIONS: 'true', GITHUB_STEP_SUMMARY: file }]],
  ]) {
    assert.equal(writeJobSummary(...args), null, name);
    assert.equal(readFileSync(file, 'utf8'), untouched, name);
  }
  const relative = 'rv-held-queue-relative-summary.md';
  assert.equal(writeJobSummary(report, { GITHUB_ACTIONS: 'true', GITHUB_STEP_SUMMARY: relative }), null);
  assert.equal(existsSync(relative), false, 'a relative path is never written');
});

test('writeJobSummary returns a warning when the path is a directory, and does not throw', (t) => {
  const dir = temp(t, 'rv-held-queue-summary-dir-');
  const report = { runId: 'run-1', heldQueue: heldQueue([held('below-gate')], null) };
  const warning = writeJobSummary(report, { GITHUB_ACTIONS: 'true', GITHUB_STEP_SUMMARY: dir });
  assert.match(warning, /^The held findings were not added to the job summary: /);
});

// --- the scope block ---

const HEAD = 'a1b2c3d' + 'e'.repeat(33);
const REPO = 'acme/web';
const PR = 7;
const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

function fakeGitHub(files) {
  return async (url) => {
    const path = new URL(String(url)).pathname;
    if (/\/pulls\/\d+$/.test(path)) return json({ head: { sha: HEAD } });
    if (path.endsWith('/files')) return json(files);
    if (path.endsWith('/reviews')) return json([]);
    if (path.endsWith('/check-runs')) return json({ total_count: 1, check_runs: [{ id: 1, name: 'build', status: 'completed', conclusion: 'success', completed_at: '2026-11-01T10:00:00Z' }] });
    if (path.endsWith('/status')) return json({ state: 'success', total_count: 0, statuses: [] });
    throw new Error(`Unexpected GitHub request: ${path}`);
  };
}

test('the scope block is byte-identical with held_queue on and off, and with and without a path hold', async (t) => {
  const data = temp(t, 'rv-held-queue-scope-');
  const db = openDatabase(join(data, 'review-voice.db'));
  t.after(() => db.close());
  const all = HELD_VERDICTS.map((verdict, index) => ({ path: 'src/held.ts', line: index + 1, verdict, source: 'verifier', reason: 'Local held reason.' }));
  recordRun(db, { repository: REPO, baseRef: null, headRef: HEAD, pullNumber: PR, diff: 'diff', output: 'No actionable findings.', scores: [], held: all });
  const verdict = (policy) =>
    computeVerdict({
      db,
      client: new GitHubClient({ allowlist: [REPO], token: 't', fetchImpl: fakeGitHub([{ filename: 'db/migrate/001.sql', status: 'added', contents_url: `https://api.github.com/repos/${REPO}/contents/db%2Fmigrate%2F001.sql?ref=${HEAD}` }]), sleep: async () => {} }),
      repository: REPO,
      pullNumber: PR,
      head: HEAD,
      review: 'No actionable findings.',
      owner: 'your-github-login',
      policy: { scopeBlock: true, ...policy },
    });
  const block = (result) => result.output.payload.body.slice(result.output.payload.body.indexOf('<details><summary>Review scope</summary>'));
  const off = await verdict({ heldQueue: false });
  const on = await verdict({ heldQueue: true });
  const hold = await verdict({ heldQueue: true, neverApprovePaths: ['db/migrate/**'] });
  assert.equal(off.output.event, 'APPROVE');
  assert.equal(hold.output.event, 'COMMENT', 'the path hold applied');
  assert.ok(block(off).startsWith('<details>'));
  assert.equal(block(on), block(off));
  assert.equal(block(hold), block(off));
  assert.deepEqual(on.output.payload, off.output.payload);

  const counts = heldCounts(off.run.held);
  assert.equal(off.run.held.length, HELD_VERDICTS.length);
  assert.equal(heldQueue(off.run.held, null).length, Object.values(counts).reduce((sum, n) => sum + n, 0));
});

// --- documents ---

test('documentation: help, the example config, ADR 0031, the ADR index and WATCHER.md name held_queue', (t) => {
  const help = (command) => execFileSync(process.execPath, [bundle, command, '--help'], { encoding: 'utf8' });
  assert.ok(help('verdict').includes('verdict.held_queue:'));
  const review = help('review');
  assert.ok(review.includes('heldQueue'));
  assert.ok(review.includes('job summary'));

  const example = readFileSync(join(root, 'plugins/review-voice/templates/config.example.yaml'), 'utf8');
  assert.ok(example.includes('held_queue: false'));
  assert.deepEqual(configFrom(t, example).warnings, []);

  const adr = readFileSync(join(root, 'docs/adr/0031-a-github-action-runs-one-review-per-pull-request-event.md'), 'utf8');
  assert.match(adr, /## Amendment - 2026/);
  assert.ok(adr.includes('held_queue'));
  for (const doc of ['docs/adr/README.md', 'docs/WATCHER.md']) {
    assert.ok(readFileSync(join(root, doc), 'utf8').includes('held_queue'), doc);
  }
});
