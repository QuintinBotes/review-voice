/**
 * An unknown key inside a known config section warns as an unknown top-level
 * key does, so a typo in a setting such as verdict.never_approve is named
 * rather than silently dropped (#318).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { CONFIG_KEYS, loadConfig, readConfigDocument } from '../plugins/review-voice/src/policy/load.ts';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const plugin = join(root, 'plugins/review-voice');
const bundle = join(plugin, 'dist/review-voice.mjs');
const example = join(plugin, 'templates/config.example.yaml');
const watcherDoc = join(root, 'docs/WATCHER.md');
const NO_BASELINE = join(tmpdir(), 'rv-no-such-baseline.yaml');
const unknown = (key) => `${key} is not a setting Review Voice reads; ignoring it.`;
// An inherited override would make loadConfig, here and in the CLI child, read another file than the temp repo's.
delete process.env.REVIEW_VOICE_CONFIG;

function withRepo(config, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'rv-issue-318-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: dir });
    mkdirSync(join(dir, '.review-voice'));
    writeFileSync(join(dir, '.review-voice', 'config.yaml'), config);
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('the issue repro warns for each misspelt nested key through the CLI', () =>
  withRepo('verdict:\n  never_aprove: true\nreview:\n  suggestion: true\n', (dir) => {
    // `context` opens the store to load approved policies; a fresh data directory keeps it off the developer's own.
    const run = spawnSync(process.execPath, [bundle, 'context'], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, REVIEW_VOICE_DATA_DIR: join(dir, 'data') },
    });
    assert.equal(run.status, 0, run.stderr);
    const { warnings } = JSON.parse(run.stdout);
    assert.ok(warnings.includes(unknown('verdict.never_aprove')), warnings.join('\n'));
    assert.ok(warnings.includes(unknown('review.suggestion')), warnings.join('\n'));
  }));

test('an unknown key in every section the loader parses is named by its full dotted key', () => {
  const config = [
    'bogus_top: 1',
    'identity: { owner_reviewer: your-github-login, bogus: 1 }',
    'repositories: { include: [], bogus: 1 }',
    'writes: { github_posting_enabled: false, bogus: 1 }',
    'verdict: { never_approve: true, bogus: 1 }',
    'verification: { enabled: false, bogus: 1 }',
    'watch: { post: false, bogus: 1 }',
    'retention: { runs_days: 30, bogus: 1 }',
    'outcomes: { approval_window_days: 14, bogus: 1 }',
    'review:',
    '  bogus: 1',
    '  human_review: { cap_approval: true, bogus: 1, structure: { branch_growth: false, bogus: 1 } }',
    '  structure: { simplify: false, bogus: 1 }',
    '  lanes:',
    '    - name: extra',
    '      agent: structure-analyst',
    '      prefix: ex_',
    '      bogus: 1',
    '      when: { pathz: [src], min_changed_source_lines: 1 }',
    '      severity: { capp: minor, escalate: { to: important, requires: blocker_confirmed, bogus: 1 } }',
    'ci:',
    '  bogus: 1',
    '  gate_checks: [{ name: gate, bogus: 1 }]',
    '  stuck_after_overrides: [{ name: slow, minutes: 90, bogus: 1 }]',
    'static_evidence:',
    '  bogus: 1',
    '  commands: [{ name: check, run: "true", timeout_secs: 5 }]',
    'reproduction:',
    '  bogus: 1',
    '  runners: [{ name: node-test, run: "node --test {file}", extension: .test.mjs, bogus: 1 }]',
    'queue:',
    '  bogus: 1',
    '  skip: { drafts: true, bogus: 1, approved_at_head_by: { logins: [], bogus: 1 } }',
    '',
  ].join('\n');
  withRepo(config, (dir) => {
    const { warnings, verdictPolicy, lanes } = loadConfig(dir, NO_BASELINE);
    const named = warnings.filter((warning) => warning.endsWith('is not a setting Review Voice reads; ignoring it.'));
    assert.deepEqual(named.sort(), [
      'bogus_top',
      'identity.bogus',
      'repositories.bogus',
      'writes.bogus',
      'verdict.bogus',
      'verification.bogus',
      'watch.bogus',
      'retention.bogus',
      'outcomes.bogus',
      'review.bogus',
      'review.human_review.bogus',
      'review.human_review.structure.bogus',
      'review.structure.bogus',
      'review.lanes[0].bogus',
      'review.lanes[0].when.pathz',
      'review.lanes[0].severity.capp',
      'review.lanes[0].severity.escalate.bogus',
      'ci.bogus',
      'ci.gate_checks[0].bogus',
      'ci.stuck_after_overrides[0].bogus',
      'static_evidence.bogus',
      'static_evidence.commands[0].timeout_secs',
      'reproduction.bogus',
      'reproduction.runners[0].bogus',
      'queue.bogus',
      'queue.skip.bogus',
      'queue.skip.approved_at_head_by.bogus',
    ].map(unknown).sort());
    // Known keys beside the unknown ones still apply.
    assert.equal(verdictPolicy.neverApprove, true);
    assert.equal(lanes.length, 2);
  });
});

test('the shipped example config and the documented one have no key the loader does not read', () => {
  const documented = readFileSync(watcherDoc, 'utf8').split('## Configuration')[1].match(/```yaml\n([\s\S]*?)```/)[1];
  for (const config of [readFileSync(example, 'utf8'), documented]) {
    withRepo(config, (dir) => {
      const { warnings } = loadConfig(dir, NO_BASELINE);
      assert.deepEqual(warnings.filter((warning) => warning.includes('is not a setting')), []);
    });
  }
});

/** `value` with every mapping in it recording, by dotted path, each key the loader reads from it. */
function recording(value, path, reads) {
  if (Array.isArray(value)) return value.map((entry) => recording(entry, `${path}[]`, reads));
  if (value === null || typeof value !== 'object') return value;
  const target = Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, recording(child, path === '' ? key : `${path}.${key}`, reads)]),
  );
  return new Proxy(target, {
    get(object, key, receiver) {
      if (typeof key === 'string') (reads[path] ??= new Set()).add(key);
      return Reflect.get(object, key, receiver);
    },
  });
}

test('the loader reads exactly the keys CONFIG_KEYS lists for each section', () => {
  // Every section present, and each list entry valid enough that its reader reaches every key.
  const doc = parseYaml(
    [
      'identity: {}',
      'repositories: {}',
      'writes: {}',
      'verdict: {}',
      'verification: {}',
      'watch: {}',
      'retention: {}',
      'outcomes: { approval_window_days: 14, approval_escape_warn: 0.05 }',
      'review:',
      '  human_review: { structure: {} }',
      '  structure: {}',
      '  lanes:',
      '    - name: extra',
      '      agent: structure-analyst',
      '      prefix: ex_',
      '      when: {}',
      '      severity: { escalate: { to: important, requires: blocker_confirmed } }',
      'ci:',
      '  gate_checks: [{ name: gate }]',
      '  stuck_after_overrides: [{}]',
      'static_evidence:',
      '  commands: [{ name: check, run: "true" }]',
      'reproduction:',
      '  enabled: false',
      '  runners: [{ name: node-test, run: "node --test {file}", extension: .test.mjs }]',
      '  link_paths: [node_modules]',
      '  memory_mb: 1024',
      '  cpu_seconds: 60',
      'queue:',
      '  skip: { approved_at_head_by: {} }',
      '',
    ].join('\n'),
  );
  const reads = {};
  const dir = mkdtempSync(join(tmpdir(), 'rv-issue-318-reads-'));
  try {
    const result = loadConfig(dir, NO_BASELINE);
    readConfigDocument(recording(doc, '', reads), dir, result);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const sorted = (table) => Object.fromEntries(Object.entries(table).map(([path, keys]) => [path, [...keys].sort()]).sort());
  // A key read but not listed, or listed but not read, shows up as a difference here.
  assert.deepEqual(sorted(reads), sorted(CONFIG_KEYS));
});
