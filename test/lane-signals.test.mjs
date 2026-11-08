/**
 * S11: a lane may wake on a structural signal (`when.signals`) as well as on
 * line counts. Covers `parseLane` validation, `eligibleLanes` with the
 * manifest's `structure` block, and the `lanes` command through the bundle.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../plugins/review-voice/src/policy/load.ts';
import { DIFF_LANE, LANE_SIGNALS, eligibleLanes } from '../plugins/review-voice/src/review/lanes.ts';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bundle = join(root, 'plugins/review-voice/dist/review-voice.mjs');

const SIGNALS = ['removed-controls', 'risk-markers', 'type-escapes', 'branch-growth', 'size-crossing'];
/** The list in `structure` each signal name reads. */
const KEYS = {
  'removed-controls': 'removedControls',
  'risk-markers': 'riskMarkers',
  'type-escapes': 'typeEscapes',
  'branch-growth': 'branchGrowth',
  'size-crossing': 'sizeCrossings',
};

const lane = (when, extra = {}) => ({
  name: 'security',
  agent: 'security-analyst',
  prefix: 'sec_',
  when,
  severity: {},
  ...extra,
});

const file = (path, extra = {}) => ({
  path, status: 'modified', class: 'source', language: 'ts', additions: 0, deletions: 0, reviewed: true, ...extra,
});

const entry = (path = 'src/a.ts') => ({ path, line: 3, kind: 'x' });
const structureWith = (key, ...entries) => ({ sizeCrossings: [], branchGrowth: [], typeEscapes: [], removedControls: [], riskMarkers: [], [key]: entries });

/** The one non-diff lane's eligibility. */
const decide = (security, files, structure) => eligibleLanes([DIFF_LANE, security], files, '', { structure })[1];

// ---- parseLane -----------------------------------------------------------------

function withRepo(yaml, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'rv-lane-signals-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: dir });
    if (yaml !== null) {
      mkdirSync(join(dir, '.review-voice'));
      writeFileSync(join(dir, '.review-voice', 'config.yaml'), yaml);
    }
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const SECURITY_YAML = (when) => `review:\n  lanes:\n    - name: security\n      agent: security-analyst\n      prefix: sec_\n      when: ${when}\n      severity: { escalate: { to: blocking, requires: blocker_confirmed } }\n`;

test('the closed signal list is the five the spec names', () => {
  assert.deepEqual([...LANE_SIGNALS].sort(), [...SIGNALS].sort());
});

test('a valid signals list round-trips with the paths and minimum beside it', () => {
  const config = withRepo(SECURITY_YAML("{ signals: [removed-controls, risk-markers], paths: ['src/**'], min_changed_source_lines: 80 }"), (dir) => loadConfig(dir));
  assert.deepEqual(config.warnings, []);
  assert.deepEqual(config.lanes[1], {
    name: 'security',
    agent: 'security-analyst',
    prefix: 'sec_',
    when: { minChangedSourceLines: 80, paths: ['src/**'], signals: ['removed-controls', 'risk-markers'] },
    severity: { escalate: { to: 'blocking', requires: 'blocker_confirmed' } },
  });
  const alone = withRepo(SECURITY_YAML('{ signals: [removed-controls] }'), (dir) => loadConfig(dir));
  assert.deepEqual(alone.lanes[1].when, { signals: ['removed-controls'] });
});

test('every signal name is accepted', () => {
  const config = withRepo(SECURITY_YAML(`{ signals: [${SIGNALS.join(', ')}] }`), (dir) => loadConfig(dir));
  assert.deepEqual(config.warnings, []);
  assert.deepEqual(config.lanes[1].when.signals, SIGNALS);
});

test('an unknown signal drops the lane with a warning; the other lanes still load', () => {
  const bad = [
    '{ signals: [removed-control] }',
    '{ signals: [removed-controls, secrets] }',
    '{ signals: removed-controls }',
    '{ signals: [1] }',
    '{ signals: { removed-controls: true } }',
  ];
  for (const when of bad) {
    const config = withRepo(SECURITY_YAML(when), (dir) => loadConfig(dir));
    assert.deepEqual(config.lanes, [DIFF_LANE], when);
    assert.equal(config.warnings.length, 1, when);
    assert.match(config.warnings[0], /^review\.lanes\[0\]: when\.signals must list only removed-controls, risk-markers, type-escapes, branch-growth, size-crossing; dropping the lane\.$/);
  }
  const mixed = `${SECURITY_YAML('{ signals: [nope] }')}    - name: concurrency\n      agent: concurrency-analyst\n      prefix: cc_\n      when: { signals: [risk-markers] }\n`;
  const config = withRepo(mixed, (dir) => loadConfig(dir));
  assert.deepEqual(config.lanes.map((l) => l.name), ['diff', 'concurrency']);
  assert.equal(config.warnings.length, 1);
  assert.match(config.warnings[0], /^review\.lanes\[0\]: /);
});

test('a lane without signals parses as it did, with no signals key', () => {
  const config = withRepo(SECURITY_YAML('{ min_changed_source_lines: 40 }'), (dir) => loadConfig(dir));
  assert.deepEqual(config.warnings, []);
  assert.deepEqual(config.lanes[1].when, { minChangedSourceLines: 40 });
  assert.equal('signals' in config.lanes[1].when, false);
});

// ---- eligibleLanes -----------------------------------------------------------------

for (const signal of SIGNALS) {
  test(`signal ${signal}: eligible on one entry, ineligible on none`, () => {
    const security = lane({ signals: [signal] });
    const fired = decide(security, [file('src/a.ts', { additions: 1 })], structureWith(KEYS[signal], entry()));
    assert.equal(fired.eligible, true);
    assert.equal(fired.reason, `${signal}: 1 entry`);
    const quiet = decide(security, [file('src/a.ts', { additions: 1 })], structureWith(KEYS[signal]));
    assert.equal(quiet.eligible, false);
    assert.equal(quiet.reason, `none of ${signal} fired, and no line minimum is set`);
    // A different signal's entries do not wake this lane.
    const other = SIGNALS.find((name) => name !== signal);
    assert.equal(decide(security, [file('src/a.ts')], structureWith(KEYS[other], entry())).eligible, false);
  });
}

test('with no structure block, a missing key or a malformed list, a signal lane has no signal', () => {
  const security = lane({ signals: ['removed-controls'] });
  const files = [file('src/a.ts', { additions: 500 })];
  for (const structure of [undefined, null, 'structure', 7, [], {}, { riskMarkers: [entry()] }, { removedControls: 'src/a.ts' }, { removedControls: { path: 'src/a.ts' } }, { removedControls: [] }]) {
    const result = decide(security, files, structure);
    assert.equal(result.eligible, false, JSON.stringify(structure));
    assert.equal(result.reason, 'none of removed-controls fired, and no line minimum is set');
  }
});

test('500 changed source lines with no signal do not wake a signal-only lane', () => {
  const result = decide(lane({ signals: ['removed-controls'] }), [file('src/a.ts', { additions: 500 })], structureWith('removedControls'));
  assert.equal(result.eligible, false);
});

test('an entry that is not an object with a string path counts for nothing', () => {
  const security = lane({ signals: ['removed-controls'] });
  for (const bad of [null, 'src/a.ts', 3, {}, { path: 7 }, { line: 1 }]) {
    assert.equal(decide(security, [file('src/a.ts')], { removedControls: [bad] }).eligible, false, JSON.stringify(bad));
  }
});

test('signals without any listed name wake nothing', () => {
  const result = decide(lane({ signals: [] }), [file('src/a.ts', { additions: 500 })], structureWith('removedControls', entry()));
  assert.equal(result.eligible, false);
  assert.equal(result.reason, 'none of no signals fired, and no line minimum is set');
});

test('with signals and a minimum, either clause wakes the lane and the reason names which', () => {
  const security = lane({ signals: ['removed-controls'], minChangedSourceLines: 40 });
  const some = [file('src/a.ts', { additions: 10 })];
  const many = [file('src/a.ts', { additions: 30, deletions: 10 })];

  const signalOnly = decide(security, some, structureWith('removedControls', entry()));
  assert.equal(signalOnly.eligible, true);
  assert.equal(signalOnly.reason, 'removed-controls: 1 entry');

  const linesOnly = decide(security, many, structureWith('removedControls'));
  assert.equal(linesOnly.eligible, true);
  assert.equal(linesOnly.reason, '40 changed source lines, at least 40');

  const both = decide(security, many, structureWith('removedControls', entry(), entry()));
  assert.equal(both.eligible, true);
  assert.equal(both.reason, 'removed-controls: 2 entries; 40 changed source lines, at least 40');

  const neither = decide(security, some, structureWith('removedControls'));
  assert.equal(neither.eligible, false);
  assert.equal(neither.reason, 'none of removed-controls fired, and 10 changed source lines is under the minimum of 40');

  // A missing structure block leaves only the minimum.
  assert.equal(decide(security, many, undefined).eligible, true);
  assert.equal(decide(security, some, undefined).eligible, false);
});

test('an explicit minimum of 0 is a minimum that is met', () => {
  const result = decide(lane({ signals: ['removed-controls'], minChangedSourceLines: 0 }), [file('docs/x.md', { additions: 1 })], undefined);
  assert.equal(result.eligible, true);
  assert.equal(result.reason, '0 changed source lines, at least 0');
});

test('several signals are listed in the reason, each with its count', () => {
  const security = lane({ signals: ['removed-controls', 'risk-markers', 'type-escapes'] });
  const structure = { ...structureWith('riskMarkers', entry(), entry('src/b.ts')), removedControls: [entry()] };
  const result = decide(security, [file('src/a.ts', { additions: 1 })], structure);
  assert.equal(result.eligible, true);
  assert.equal(result.reason, 'removed-controls: 1 entry; risk-markers: 2 entries');
});

test("signal entries are filtered by the lane's paths", () => {
  const security = lane({ signals: ['risk-markers'], paths: ['src/**'] });
  const files = [file('src/a.ts', { additions: 1 }), file('scripts/build.ts', { additions: 1 })];
  const outside = decide(security, files, structureWith('riskMarkers', entry('scripts/build.ts'), entry('docs/x.ts')));
  assert.equal(outside.eligible, false);
  assert.equal(outside.reason, 'none of risk-markers fired in src/**, and no line minimum is set');

  const inside = decide(security, files, structureWith('riskMarkers', entry('scripts/build.ts'), entry('src/a.ts')));
  assert.equal(inside.eligible, true);
  assert.equal(inside.reason, 'risk-markers: 1 entry in src/**');

  // No paths on the lane: an entry anywhere counts.
  assert.equal(decide(lane({ signals: ['risk-markers'] }), files, structureWith('riskMarkers', entry('scripts/build.ts'))).eligible, true);
});

test('a lane without signals behaves exactly as before, whatever the structure block holds', () => {
  const all = { sizeCrossings: [entry()], branchGrowth: [entry()], typeEscapes: [entry()], removedControls: [entry()], riskMarkers: [entry()] };
  const minimum = lane({ minChangedSourceLines: 40, paths: ['src/**'] });
  assert.equal(decide(minimum, [file('src/a.ts', { additions: 39 })], all).eligible, false);
  assert.equal(decide(minimum, [file('src/a.ts', { additions: 39 })], all).reason, '39 changed source lines in src/**, under the minimum of 40');
  assert.equal(decide(minimum, [file('src/a.ts', { additions: 40 })], undefined).reason, '40 changed source lines in src/**, at least 40');
  // No minimum and no signals still means always eligible.
  assert.equal(decide(lane({}), [file('docs/x.md', { additions: 3 })], undefined).eligible, true);
  assert.equal(decide(lane({}), [file('docs/x.md', { additions: 3 })], undefined).reason, '0 changed source lines, at least 0');
});

test('the diff lane always runs and is not affected by signals', () => {
  const [diff] = eligibleLanes([DIFF_LANE], [], '', { structure: structureWith('removedControls') });
  assert.deepEqual([diff.eligible, diff.reason], [true, 'the diff lane always runs']);
});

// ---- the lanes command ------------------------------------------------------------------

function cli(dir, args) {
  return spawnSync(process.execPath, [bundle, ...args], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, REVIEW_VOICE_DATA_DIR: join(dir, '.data') },
  });
}

test('lanes command reads structure.removedControls from files.json', () =>
  withRepo(SECURITY_YAML('{ signals: [removed-controls] }'), (dir) => {
    writeFileSync(join(dir, 'diff.patch'), '');
    const run = (manifest) => {
      writeFileSync(join(dir, 'files.json'), JSON.stringify(manifest));
      const result = cli(dir, ['lanes', '--files', join(dir, 'files.json'), '--diff-file', join(dir, 'diff.patch')]);
      assert.equal(result.status, 0, result.stderr);
      return JSON.parse(result.stdout);
    };
    const big = [file('src/a.ts', { additions: 500 })];

    const removed = run({ files: big, structure: { removedControls: [{ path: 'src/a.ts', line: 3, kind: 'guard', text: 'if (!ok) stop();', deletedFile: false }] } });
    assert.deepEqual(removed.map((e) => [e.lane.name, e.eligible]), [['diff', true], ['security', true]]);
    assert.equal(removed[1].reason, 'removed-controls: 1 entry');
    assert.deepEqual(removed[1].lane.when, { signals: ['removed-controls'] });

    const none = run({ files: big, structure: { removedControls: [] } });
    assert.deepEqual(none.map((e) => [e.lane.name, e.eligible]), [['diff', true], ['security', false]]);

    // The existing CLI tests write a files.json with no structure block.
    const noBlock = run({ files: big });
    assert.equal(noBlock[1].eligible, false);
    assert.equal(noBlock[1].reason, 'none of removed-controls fired, and no line minimum is set');
  }));
