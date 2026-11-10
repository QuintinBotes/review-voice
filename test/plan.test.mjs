/**
 * Cost modes and the stage plan (docs/adr/0025): a pure table over the modes,
 * the diff's facts and the configuration, plus the `plan` command.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { modelForFinding, productionChange, resolvePlan } from '../plugins/review-voice/src/review/plan.ts';
import { loadConfig } from '../plugins/review-voice/src/policy/load.ts';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bundle = join(root, 'plugins/review-voice/dist/review-voice.mjs');

const DOCS = { productionSourceChanged: false, productionLinesChanged: 0, complexity: 'normal' };
const SMALL = { productionSourceChanged: true, productionLinesChanged: 12, complexity: 'normal' };
const BIG = { productionSourceChanged: true, productionLinesChanged: 151, complexity: 'normal' };
const EDGE = { productionSourceChanged: true, productionLinesChanged: 150, complexity: 'normal' };
const HIGH = { productionSourceChanged: true, productionLinesChanged: 5, complexity: 'high' };

const S = 'sonnet';
const O = 'opus';
const on = (model) => ({ run: true, model });
const off = { run: false, model: null };

// Expected plan per mode, for second pass off / on.
const EXPECTED = {
  fast: () => ({
    intent: on(S), lanes: on(S), verify: on(S), reproduce: off, 'second-pass': off, 'tie-break': on(S), challenge: off, edit: on(S),
    laneModels: { diff: S, others: null },
  }),
  standard: (second) => ({
    intent: on(S), lanes: on(S), verify: on(S), reproduce: off, 'second-pass': second ? { run: true, model: null } : off,
    'tie-break': on(O), challenge: on(S), edit: on(S), laneModels: { diff: S, others: S },
  }),
  thorough: (second) => ({
    intent: on(S), lanes: on(O), verify: on(O), reproduce: off, 'second-pass': second ? { run: true, model: null } : off,
    'tie-break': on(O), challenge: on(O), edit: on(S), laneModels: { diff: O, others: O },
  }),
};

const FACTS = [
  ['docs only', DOCS, 'fast', 'auto: no production source changed'],
  ['small source change', SMALL, 'standard', 'auto: production source changed within the standard limits'],
  ['150 production lines', EDGE, 'standard', 'auto: production source changed within the standard limits'],
  ['151 production lines', BIG, 'thorough', 'auto: 151 production lines changed (over 150)'],
  ['high complexity', HIGH, 'thorough', 'auto: complexity is high'],
];

for (const [name, facts, mode, reason] of FACTS) {
  for (const secondPassConfigured of [false, true]) {
    test(`auto on ${name}, second pass ${secondPassConfigured ? 'on' : 'off'} picks ${mode}`, () => {
      const plan = resolvePlan({ requested: 'auto', ...facts, secondPassConfigured });
      assert.equal(plan.mode, mode);
      assert.equal(plan.requested, 'auto');
      assert.equal(plan.reason, reason);
      const { laneModels, ...stages } = EXPECTED[mode](secondPassConfigured);
      assert.deepEqual(plan.stages, stages);
      assert.deepEqual(plan.laneModels, laneModels);
    });
  }
}

for (const mode of ['fast', 'standard', 'thorough']) {
  for (const [name, facts] of FACTS) {
    test(`an explicit ${mode} beats the diff (${name}) and says so`, () => {
      const plan = resolvePlan({ requested: mode, ...facts, secondPassConfigured: true });
      assert.equal(plan.mode, mode);
      assert.equal(plan.requested, mode);
      assert.equal(plan.reason, `mode set to ${mode}`);
      assert.equal(plan.stages.verify.run, true);
      assert.equal(plan.stages['second-pass'].run, mode !== 'fast');
    });
  }
}

test('reproduce runs only in thorough with a reproduction configured, and never has a model', () => {
  for (const mode of ['fast', 'standard', 'thorough']) {
    for (const reproductionConfigured of [false, true]) {
      const plan = resolvePlan({ requested: mode, ...SMALL, secondPassConfigured: false, reproductionConfigured });
      assert.deepEqual(plan.stages.reproduce, mode === 'thorough' && reproductionConfigured ? { run: true, model: null } : off, `${mode} ${reproductionConfigured}`);
    }
  }
  // auto reaches thorough the same way, so a large change runs it too.
  assert.equal(resolvePlan({ requested: 'auto', ...BIG, secondPassConfigured: false, reproductionConfigured: true }).stages.reproduce.run, true);
});

test('verify runs in every mode, with or without a second pass', () => {
  for (const mode of ['fast', 'standard', 'thorough']) {
    for (const secondPassConfigured of [false, true]) {
      assert.equal(resolvePlan({ requested: mode, ...SMALL, secondPassConfigured }).stages.verify.run, true);
    }
  }
});

test('modelForFinding: verify always runs, on opus for important and above in standard', () => {
  const table = [
    ['fast', 'blocking', S], ['fast', 'nit', S],
    ['standard', 'blocking', O], ['standard', 'important', O], ['standard', 'minor', S],
    ['standard', 'nit', S], ['standard', 'question', S],
    ['thorough', 'nit', O], ['thorough', 'minor', O], ['thorough', 'question', O],
  ];
  for (const [mode, severity, model] of table) {
    const plan = resolvePlan({ requested: mode, ...SMALL, secondPassConfigured: false });
    assert.deepEqual(modelForFinding(plan, 'verify', severity), { run: true, model }, `${mode} ${severity}`);
  }
});

test('modelForFinding: challenge floor in fast, opus for important and above in standard', () => {
  const table = [
    ['fast', 'blocking', true, S], ['fast', 'important', true, S], ['fast', 'minor', true, S],
    ['fast', 'nit', false, null], ['fast', 'question', false, null],
    ['standard', 'blocking', true, O], ['standard', 'important', true, O], ['standard', 'minor', true, S],
    ['standard', 'nit', true, S],
    ['thorough', 'blocking', true, O], ['thorough', 'minor', true, O], ['thorough', 'nit', true, O],
  ];
  for (const [mode, severity, run, model] of table) {
    const plan = resolvePlan({ requested: mode, ...SMALL, secondPassConfigured: false });
    assert.deepEqual(modelForFinding(plan, 'challenge', severity), { run, model }, `${mode} ${severity}`);
  }
});

test('review.models replaces the model in every mode and never switches a stage on or off', () => {
  const models = { intent: 'a', lanes: 'b', verify: 'c', 'tie-break': 'd', challenge: 'e', edit: 'f' };
  for (const mode of ['fast', 'standard', 'thorough']) {
    const base = resolvePlan({ requested: mode, ...SMALL, secondPassConfigured: true });
    const plan = resolvePlan({ requested: mode, models, ...SMALL, secondPassConfigured: true });
    for (const stage of Object.keys(base.stages)) {
      assert.equal(plan.stages[stage].run, base.stages[stage].run, `${mode} ${stage} run`);
    }
    assert.equal(plan.stages.intent.model, 'a');
    assert.equal(plan.stages.lanes.model, 'b');
    assert.equal(plan.stages.verify.model, 'c');
    assert.equal(plan.stages['tie-break'].model, 'd');
    assert.equal(plan.stages.edit.model, 'f');
    assert.equal(plan.stages.challenge.model, mode === 'fast' ? null : 'e');
    assert.equal(plan.laneModels.diff, 'b');
    assert.equal(plan.laneModels.others, mode === 'fast' ? null : 'b');
    assert.equal(modelForFinding(plan, 'verify', 'nit').model, 'c');
  }
  const fast = resolvePlan({ requested: 'fast', models, ...SMALL, secondPassConfigured: false });
  assert.deepEqual(modelForFinding(fast, 'challenge', 'minor'), { run: true, model: 'e' });
  assert.deepEqual(modelForFinding(fast, 'challenge', 'nit'), { run: false, model: null });
});

test('the analyst override sets only the diff lane', () => {
  const plan = resolvePlan({ requested: 'standard', models: { analyst: 'x' }, ...SMALL, secondPassConfigured: false });
  assert.deepEqual(plan.laneModels, { diff: 'x', others: S });
});

function repoWith(config) {
  const dir = mkdtempSync(join(tmpdir(), 'rv-plan-'));
  mkdirSync(join(dir, '.review-voice'));
  writeFileSync(join(dir, '.review-voice', 'config.yaml'), config);
  return dir;
}

test('config: no keys means auto and no overrides', () => {
  const dir = repoWith('review:\n  max_words_per_finding: 40\n');
  try {
    const config = loadConfig(dir);
    assert.deepEqual(config.costMode, { mode: 'auto', models: {} });
    assert.deepEqual(config.warnings, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('config: valid mode and models are read', () => {
  const dir = repoWith('review:\n  mode: thorough\n  models:\n    verify: opus\n    edit: haiku\n');
  try {
    const config = loadConfig(dir);
    assert.deepEqual(config.costMode, { mode: 'thorough', models: { verify: 'opus', edit: 'haiku' } });
    assert.deepEqual(config.warnings, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('config: a bad mode, unknown stage and non-string model warn and are ignored', () => {
  const dir = repoWith('review:\n  mode: turbo\n  models:\n    verify: 3\n    bogus: opus\n    edit: haiku\n');
  try {
    const config = loadConfig(dir);
    assert.deepEqual(config.costMode, { mode: 'auto', models: { edit: 'haiku' } });
    assert.equal(config.warnings.length, 3);
    assert.match(config.warnings.join('\n'), /review\.mode must be one of/);
    assert.match(config.warnings.join('\n'), /review\.models\.bogus is not a stage/);
    assert.match(config.warnings.join('\n'), /review\.models\.verify must be a model name/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('config: models that is not a map warns', () => {
  const dir = repoWith('review:\n  models: opus\n');
  try {
    const config = loadConfig(dir);
    assert.deepEqual(config.costMode.models, {});
    assert.match(config.warnings.join('\n'), /review\.models must be a map/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const file = (path, extra = {}) => ({
  path, status: 'modified', class: 'source', language: 'ts', additions: 3, deletions: 1, reviewed: true, ...extra,
});

test('productionChange leaves out tests, documentation and generated files', () => {
  const result = productionChange(
    [file('src/a.ts'), file('src/a.test.ts', { additions: 50 }), file('README.md', { additions: 90 }), file('src/gen.ts', { class: 'generated', additions: 70 })],
    '',
  );
  assert.deepEqual(result, { productionSourceChanged: true, productionLinesChanged: 4 });
});

test('productionChange: docs and tests only is no production change', () => {
  const result = productionChange([file('docs/x.md'), file('test/x.test.mjs')], '');
  assert.deepEqual(result, { productionSourceChanged: false, productionLinesChanged: 0 });
});

test('productionChange counts the diff for a file that records no line counts', () => {
  const diff = [
    'diff --git a/src/a.ts b/src/a.ts', '--- a/src/a.ts', '+++ b/src/a.ts', '@@ -1,2 +1,3 @@',
    '-old', '+new', '+newer', ' same',
    'diff --git a/src/b.ts b/src/b.ts', '--- a/src/b.ts', '+++ b/src/b.ts', '@@ -1 +1 @@', '-x', '+y', '',
  ].join('\n');
  const bare = (path) => ({ path, status: 'modified', class: 'source', language: 'ts', reviewed: true });
  const result = productionChange([bare('src/a.ts'), bare('src/b.ts')], diff);
  assert.deepEqual(result, { productionSourceChanged: true, productionLinesChanged: 5 });
});

function planCli(args, files, diff, config) {
  const dir = mkdtempSync(join(tmpdir(), 'rv-plan-cli-'));
  const dataDir = mkdtempSync(join(tmpdir(), 'rv-plan-data-'));
  if (config !== undefined) {
    // plan reads the configuration of the repository it runs in.
    execFileSync('git', ['init', '-q'], { cwd: dir });
    mkdirSync(join(dir, '.review-voice'));
    writeFileSync(join(dir, '.review-voice/config.yaml'), JSON.stringify(config));
  }
  const filesPath = join(dir, 'files.json');
  const diffPath = join(dir, 'diff.patch');
  if (files !== undefined) writeFileSync(filesPath, typeof files === 'string' ? files : JSON.stringify(files));
  if (diff !== undefined) writeFileSync(diffPath, diff);
  const run = spawnSync(process.execPath, [bundle, 'plan', ...args(filesPath, diffPath)], {
    cwd: dir, encoding: 'utf8', env: { ...process.env, REVIEW_VOICE_DATA_DIR: dataDir },
  });
  rmSync(dir, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
  return run;
}

const both = (f, d) => ['--files', f, '--diff-file', d];

test('plan command: prints the plan for a docs-only fixture', () => {
  const run = planCli(both, { files: [file('docs/x.md')], complexity: { level: 'normal' } }, '');
  assert.equal(run.status, 0, run.stderr);
  const plan = JSON.parse(run.stdout);
  assert.equal(plan.mode, 'fast');
  assert.equal(plan.reason, 'auto: no production source changed');
  assert.equal(plan.stages.challenge.run, false);
});

test('plan command: high complexity from files.json picks thorough, --mode beats it', () => {
  const manifest = { files: [file('src/a.ts')], complexity: { level: 'high' } };
  const auto = JSON.parse(planCli(both, manifest, '').stdout);
  assert.equal(auto.mode, 'thorough');
  assert.equal(auto.reason, 'auto: complexity is high');
  const forced = JSON.parse(planCli((f, d) => [...both(f, d), '--mode', 'fast'], manifest, '').stdout);
  assert.equal(forced.mode, 'fast');
  assert.equal(forced.requested, 'fast');
});

test('plan command: 151 production lines picks thorough', () => {
  const manifest = { files: [file('src/a.ts', { additions: 100, deletions: 51 })] };
  assert.equal(JSON.parse(planCli(both, manifest, '').stdout).mode, 'thorough');
});

test('plan command: bad invocations exit 2', () => {
  const manifest = { files: [file('src/a.ts')] };
  for (const [args, files, diff] of [
    [(f) => ['--files', f], manifest, ''],
    [(f, d) => [...both(f, d), '--mode', 'turbo'], manifest, ''],
    [(f, d) => [...both(f, d), '--mode'], manifest, ''],
    [both, undefined, ''],
    [both, '{not json', ''],
    [both, { nothing: true }, ''],
    [both, manifest, undefined],
  ]) {
    const run = planCli(args, files, diff);
    assert.equal(run.status, 2, run.stderr);
  }
});

test('plan command: the reproduce stage follows the reproduction block, in thorough only', () => {
  const manifest = { files: [file('src/a.ts')] };
  const runner = { name: 'node-test', run: 'node --test {file}', extension: '.test.mjs' };
  const stage = (mode, reproduction) => {
    const run = planCli((f, d) => [...both(f, d), '--mode', mode], manifest, '', { reproduction });
    assert.equal(run.status, 0, run.stderr);
    return JSON.parse(run.stdout).stages.reproduce;
  };
  assert.deepEqual(stage('thorough', { enabled: true, runners: [runner] }), { run: true, model: null });
  assert.deepEqual(stage('standard', { enabled: true, runners: [runner] }), off);
  assert.deepEqual(stage('thorough', { enabled: false, runners: [runner] }), off);
  assert.deepEqual(stage('thorough', { enabled: true, runners: [] }), off);
});

test('plan command: help is available', () => {
  const out = execFileSync(process.execPath, [bundle, 'plan', '--help'], { encoding: 'utf8' });
  assert.match(out, /review-voice plan --files/);
});

// ---------------------------------------------------------------- S17 part B: the plan names the challenge family

const CODEX = { command: ['codex', 'exec', '{schema}'], timeoutSeconds: 600, label: 'codex', envPassthrough: [] };
const runnersOf = (use) => ({ external: { codex: CODEX }, use: { challenge: 'claude', agentAuthoredChallenge: null, ...use } });
const authoredBy = (family) => ({ agent: family !== null, family, evidence: family === null ? [] : ['a trailer'] });

test('S17 AC-9: with no runners the challenge runs on claude for the default reason, and nothing is echoed', () => {
  const plan = resolvePlan({ requested: 'standard', ...SMALL, secondPassConfigured: false });
  assert.deepEqual(plan.families, { challenge: 'claude', reason: 'default' });
  assert.deepEqual(plan.runners, {});
});

test('S17 AC-9: runners.use.challenge names the base family and plan.runners echoes the configured blocks', () => {
  const plan = resolvePlan({ requested: 'standard', ...SMALL, secondPassConfigured: false, runners: runnersOf({ challenge: 'codex' }) });
  assert.deepEqual(plan.families, { challenge: 'codex', reason: 'runners.use.challenge' });
  assert.deepEqual(plan.runners, { codex: CODEX });
});

test('S17 AC-9: a change an agent of the base family wrote is challenged on the configured alternative', () => {
  const plan = resolvePlan({
    requested: 'standard', ...SMALL, secondPassConfigured: false,
    runners: runnersOf({ agentAuthoredChallenge: 'codex' }), authorship: authoredBy('claude'),
  });
  assert.deepEqual(plan.families, {
    challenge: 'codex',
    reason: 'agent-authored by claude; challenged on codex (runners.use.agent_authored_challenge)',
  });
});

test('S17 AC-9: an authorship of another family, other, none or unknown keeps the base family', () => {
  for (const authorship of [authoredBy('codex'), authoredBy('other'), authoredBy(null), undefined]) {
    const plan = resolvePlan({
      requested: 'standard', ...SMALL, secondPassConfigured: false,
      runners: runnersOf({ agentAuthoredChallenge: 'codex' }), ...(authorship === undefined ? {} : { authorship }),
    });
    assert.deepEqual(plan.families, { challenge: 'claude', reason: 'default' }, JSON.stringify(authorship));
  }
});

test('S17 AC-9: the rule is off unless agent_authored_challenge is set', () => {
  const plan = resolvePlan({ requested: 'standard', ...SMALL, secondPassConfigured: false, runners: runnersOf({}), authorship: authoredBy('claude') });
  assert.deepEqual(plan.families, { challenge: 'claude', reason: 'default' });
});

test('S17 AC-9: fast mode still names the family the challenge of a finding above a nit runs on', () => {
  const plan = resolvePlan({ requested: 'fast', ...DOCS, secondPassConfigured: false, runners: runnersOf({ challenge: 'codex' }) });
  assert.equal(plan.families.challenge, 'codex');
  assert.deepEqual(modelForFinding(plan, 'challenge', 'minor'), { run: true, model: S });
});

function planCliWith(t, config, extra) {
  const dir = mkdtempSync(join(tmpdir(), 'rv-plan-runners-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // The command reads configuration only inside a repository.
  execFileSync('git', ['init', '-q'], { cwd: dir });
  const configPath = join(dir, 'operator.yaml');
  writeFileSync(configPath, config);
  writeFileSync(join(dir, 'files.json'), JSON.stringify({ files: [file('src/a.ts')], complexity: { level: 'normal' } }));
  writeFileSync(join(dir, 'diff.patch'), '');
  const run = spawnSync(process.execPath, [bundle, 'plan', '--files', join(dir, 'files.json'), '--diff-file', join(dir, 'diff.patch'), ...extra(dir)], {
    cwd: dir, encoding: 'utf8', env: { ...process.env, REVIEW_VOICE_DATA_DIR: dir, REVIEW_VOICE_CONFIG: configPath },
  });
  return { run, dir };
}

const RUNNERS_YAML = ['runners:', '  codex:', '    command: [codex, exec, "{schema}"]', '  use:', '    agent_authored_challenge: codex', 'watch:', '  run_repository_commands: true', ''].join('\n');

test('S17 AC-9: plan --authorship reads the file and applies the rule from the operator configuration', (t) => {
  const { run } = planCliWith(t, RUNNERS_YAML, (dir) => {
    writeFileSync(join(dir, 'authorship.json'), JSON.stringify(authoredBy('claude')));
    return ['--authorship', join(dir, 'authorship.json')];
  });
  assert.equal(run.status, 0, run.stderr);
  const plan = JSON.parse(run.stdout);
  assert.deepEqual(plan.families, { challenge: 'codex', reason: 'agent-authored by claude; challenged on codex (runners.use.agent_authored_challenge)' });
  assert.deepEqual(plan.runners.codex.command, ['codex', 'exec', '{schema}']);
});

test('S17 AC-9: plan without --authorship names the base family', (t) => {
  const { run } = planCliWith(t, RUNNERS_YAML, () => []);
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout).families, { challenge: 'claude', reason: 'default' });
});

test('S17 AC-9: an unreadable --authorship file, or the flag with no file, exits 2', (t) => {
  for (const extra of [
    (dir) => ['--authorship', join(dir, 'missing.json')],
    (dir) => {
      writeFileSync(join(dir, 'broken.json'), '{not json');
      return ['--authorship', join(dir, 'broken.json')];
    },
    (dir) => {
      writeFileSync(join(dir, 'list.json'), '[]');
      return ['--authorship', join(dir, 'list.json')];
    },
    () => ['--authorship'],
  ]) {
    const { run } = planCliWith(t, RUNNERS_YAML, extra);
    assert.equal(run.status, 2, run.stdout);
    assert.equal(run.stdout, '');
  }
});

test('S17 AC-9: plan --help documents --authorship', () => {
  const out = execFileSync(process.execPath, [bundle, 'plan', '--help'], { encoding: 'utf8' });
  assert.match(out, /--authorship <file>/);
});
