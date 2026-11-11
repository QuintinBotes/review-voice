/**
 * S17 part A: the `runners:` block and `verification.runner` / `verification.family`
 * (docs/adr/0021, amended), each failure a warning and the default kept, and the
 * rule that `runners:` is honoured only from the operator's own configuration.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../plugins/review-voice/src/policy/load.ts';
import { resolvePlan } from '../plugins/review-voice/src/review/plan.ts';

const bundle = join(dirname(dirname(fileURLToPath(import.meta.url))), 'plugins/review-voice/dist/review-voice.mjs');

const NO_BASELINE = join(tmpdir(), 'rv-no-such-baseline.yaml');
// An inherited override would make loadConfig read another file than the temp repo's.
delete process.env.REVIEW_VOICE_CONFIG;
delete process.env.REVIEW_VOICE_CONFIG_SOURCE;

/**
 * Loads `config`, written to a temp repository's own .review-voice/config.yaml.
 * By default the file is passed as `path` with the `flag` source, as `watch --config` passes its copy;
 * 'checkout' leaves it as the repository's own file, 'env' and 'relative' name
 * it through REVIEW_VOICE_CONFIG, and a driver source ('flag', 'driver-env',
 * 'base', 'default') sets REVIEW_VOICE_CONFIG and REVIEW_VOICE_CONFIG_SOURCE as
 * the review driver does ('driver-env' is its 'env', the source watch uses).
 */
function load(config, via = 'path') {
  const dir = mkdtempSync(join(tmpdir(), 'rv-runners-config-'));
  const file = join(dir, '.review-voice', 'config.yaml');
  const saved = [process.env.REVIEW_VOICE_CONFIG, process.env.REVIEW_VOICE_CONFIG_SOURCE];
  try {
    execFileSync('git', ['init', '-q'], { cwd: dir });
    mkdirSync(join(dir, '.review-voice'));
    writeFileSync(file, config);
    if (via === 'path') return loadConfig(dir, NO_BASELINE, file, undefined, 'flag');
    if (via !== 'checkout') process.env.REVIEW_VOICE_CONFIG = via === 'relative' ? '.review-voice/config.yaml' : file;
    const source = { flag: 'flag', 'driver-env': 'env', base: 'base', default: 'default' }[via];
    if (source !== undefined) process.env.REVIEW_VOICE_CONFIG_SOURCE = source;
    return loadConfig(dir, NO_BASELINE);
  } finally {
    for (const [i, name] of ['REVIEW_VOICE_CONFIG', 'REVIEW_VOICE_CONFIG_SOURCE'].entries()) {
      if (saved[i] === undefined) delete process.env[name];
      else process.env[name] = saved[i];
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

// The trailing "-" is quoted: a bare dash inside a flow sequence is a YAML error, which is why the example quotes it too.
const CODEX = ['runners:', '  codex:', '    command: [codex, exec, --sandbox, read-only, --output-schema, "{schema}", --output-last-message, "{output}", "-"]'].join('\n');
const DEFAULT_USE = { challenge: 'claude', agentAuthoredChallenge: null };
const warned = (config, text) => config.warnings.filter((warning) => warning.includes(text));

test('AC-2: a valid runners block is read into the stated shape with the defaults', () => {
  const config = load(`${CODEX}\n`);
  assert.deepEqual(config.runners, {
    external: {
      codex: {
        command: ['codex', 'exec', '--sandbox', 'read-only', '--output-schema', '{schema}', '--output-last-message', '{output}', '-'],
        timeoutSeconds: 600,
        label: 'codex',
        envPassthrough: [],
      },
    },
    use: DEFAULT_USE,
  });
  assert.deepEqual(config.warnings.filter((warning) => !warning.startsWith('runners: codex')), []);

  const full = load([CODEX, '    timeout_seconds: 120', '    label: codex-5', '    env_passthrough: [OPENAI_API_KEY]', '  gemini:', '    command: [gemini, "{schema}"]', '  use:', '    challenge: codex', '    agent_authored_challenge: gemini', 'watch:', '  run_repository_commands: true', ''].join('\n'));
  assert.deepEqual(full.warnings, []);
  assert.deepEqual(full.runners.external.codex, {
    command: ['codex', 'exec', '--sandbox', 'read-only', '--output-schema', '{schema}', '--output-last-message', '{output}', '-'],
    timeoutSeconds: 120,
    label: 'codex-5',
    envPassthrough: ['OPENAI_API_KEY'],
  });
  assert.deepEqual(full.runners.external.gemini, { command: ['gemini', '{schema}'], timeoutSeconds: 600, label: 'gemini', envPassthrough: [] });
  assert.deepEqual(full.runners.use, { challenge: 'codex', agentAuthoredChallenge: 'gemini' });
});

test('AC-2: with no runners block nothing changes', () => {
  const config = load('identity:\n  owner_reviewer: your-github-login\n');
  assert.deepEqual(config.runners, { external: {}, use: DEFAULT_USE });
  assert.deepEqual(config.warnings, []);
});

test('AC-2: a shell string, an unknown token, a claude block, an unknown family and a bad label each warn and keep the default', () => {
  const string = load('runners:\n  codex:\n    command: codex exec -\n');
  assert.deepEqual(string.warnings, ['runners.codex.command must be a list of arguments, not a shell string; ignoring it.']);
  assert.deepEqual(string.runners.external, {});

  const token = load('runners:\n  codex:\n    command: [codex, "{file}"]\n');
  assert.deepEqual(token.warnings, ['runners.codex.command: {file} is not a token Review Voice replaces (only {schema}, {output}, {cwd}); ignoring it.']);
  assert.deepEqual(token.runners.external, {});

  const claude = load('runners:\n  claude:\n    command: [claude]\n');
  assert.deepEqual(claude.warnings, ['runners.claude: claude is the built-in runner and takes no command; ignoring it.']);

  const unknown = load('runners:\n  llama:\n    command: [llama]\n');
  assert.deepEqual(unknown.warnings, ['runners.llama is not a setting Review Voice reads; ignoring it.']);
  assert.deepEqual(unknown.runners.external, {});

  const label = load(`${CODEX}\n    label: "codex (beta)"\n`);
  assert.deepEqual(warned(label, 'runners.codex.label'), ['runners.codex.label must be a model name of up to 100 letters, digits, dots, colons, brackets, dashes or underscores; using codex.']);
  assert.equal(label.runners.external.codex.label, 'codex');

  const timeout = load(`${CODEX}\n    timeout_seconds: 0\n`);
  assert.deepEqual(warned(timeout, 'timeout_seconds'), ['runners.codex.timeout_seconds must be a whole number above zero; using 600.']);
  assert.equal(timeout.runners.external.codex.timeoutSeconds, 600);

  const empty = load('runners:\n  codex:\n    command: []\n');
  assert.deepEqual(empty.warnings, ['runners.codex.command must be a non-empty list of non-empty strings; ignoring it.']);

  const bogus = load(`${CODEX}\n    bogus: 1\n`);
  assert.ok(bogus.warnings.includes('runners.codex.bogus is not a setting Review Voice reads; ignoring it.'), bogus.warnings.join('\n'));
});

test('AC-2: a use value naming no known family warns, and is marked unreadable so the challenge holds, never runs on claude', () => {
  const unknown = load('runners:\n  use:\n    challenge: llama\n');
  assert.deepEqual(unknown.warnings, ['runners.use.challenge must be one of claude, codex, gemini; the challenge does not run and every challenged finding is held until it names one.']);
  assert.deepEqual(unknown.runners.use, { ...DEFAULT_USE, challengeUnreadable: 'runners.use.challenge is not one of claude, codex, gemini' });
});

test('AC-2: verification.runner makes the second pass the configured argv, with its timeout, family and env_passthrough', () => {
  const config = load([CODEX, '    env_passthrough: [OPENAI_API_KEY]', 'verification:', '  enabled: true', '  runner: codex', 'watch:', '  run_repository_commands: true', ''].join('\n'));
  assert.deepEqual(config.warnings, []);
  assert.equal(config.verification.enabled, true);
  assert.deepEqual(config.verification.command, ['codex', 'exec', '--sandbox', 'read-only', '--output-schema', '{schema}', '--output-last-message', '{output}', '-']);
  assert.equal(config.verification.family, 'codex');
  assert.equal(config.verification.timeoutSeconds, 600, 'the runner block\'s timeout by default');
  assert.deepEqual(config.verification.envPassthrough, ['OPENAI_API_KEY']);

  const own = load([CODEX, 'verification:', '  enabled: true', '  runner: codex', '  timeout_seconds: 45', '  command: codex exec -', ''].join('\n'));
  assert.deepEqual(warned(own, 'verification.command'), ['verification.command is ignored because verification.runner names the codex runner.']);
  assert.equal(own.verification.timeoutSeconds, 45, 'an explicit timeout wins');
  assert.deepEqual(own.verification.command, own.runners.external.codex.command);
});

test('AC-2: verification.runner naming an unconfigured family leaves the pass off, and a bad value is ignored', () => {
  const unconfigured = load('verification:\n  enabled: true\n  runner: gemini\n  command: gemini -p\n');
  assert.deepEqual(unconfigured.warnings, ['verification.runner names gemini, but there is no runners.gemini block; the second pass stays off.']);
  assert.equal(unconfigured.verification.enabled, false);
  assert.equal(unconfigured.verification.command, '');
  assert.equal(unconfigured.verification.family, undefined);

  const bad = load('verification:\n  enabled: true\n  runner: claude\n  command: echo x\n');
  assert.deepEqual(bad.warnings, ['verification.runner must be one of codex, gemini; ignoring it.']);
  assert.equal(bad.verification.enabled, true, 'the string command still applies');
  assert.equal(bad.verification.command, 'echo x');
});

test('AC-2: verification.family labels a hand-written command, and an unknown family is ignored', () => {
  const labelled = load('verification:\n  enabled: true\n  family: codex\n  command: codex exec -\n');
  assert.deepEqual(labelled.warnings, []);
  assert.equal(labelled.verification.family, 'codex');
  assert.equal(labelled.verification.command, 'codex exec -');

  const unknown = load('verification:\n  enabled: true\n  family: llama\n  command: echo x\n');
  assert.deepEqual(unknown.warnings, ['verification.family must be one of claude, codex, gemini; ignoring it.']);
  assert.equal(unknown.verification.family, undefined);

  const none = load('verification:\n  enabled: true\n  command: echo x\n');
  assert.equal(Object.hasOwn(none.verification, 'family') && none.verification.family !== undefined, false);
});

test('AC-2: the run_repository_commands warning fires only when an external family is in use and the setting is false', () => {
  const expected = (families) =>
    `runners: ${families} in use with watch.run_repository_commands false, so watched reviews run with REVIEW_VOICE_NO_COMMANDS=1, ` +
    'which keeps a configured runner from running: they skip the second pass and hold every challenged finding.';
  assert.deepEqual(load(`${CODEX}\n  use:\n    challenge: codex\n`).warnings, [expected('codex')]);
  assert.deepEqual(load(`${CODEX}\n  use:\n    agent_authored_challenge: codex\n`).warnings, [expected('codex')]);
  assert.deepEqual(load(`${CODEX}\nverification:\n  enabled: true\n  runner: codex\n`).warnings, [expected('codex')]);
  assert.deepEqual(load(`${CODEX}\n  use:\n    challenge: codex\nwatch:\n  run_repository_commands: true\n`).warnings, []);
  assert.deepEqual(load(`${CODEX}\n`).warnings, [], 'a configured but unused family is no warning');
  assert.deepEqual(load('verification:\n  enabled: true\n  command: echo x\n').warnings, [], 'a shell command is not a runner');
});

// ---- the owner's rule: runners come from the operator's own configuration only ----

const RULE =
  'runners is read only from the operator\'s own configuration (the file --config names, an absolute REVIEW_VOICE_CONFIG, ' +
  'or the Action\'s config input), never from a repository\'s own file, checked out or at a base commit, ' +
  'because a runner is a command this machine executes; ignoring it.';
const OFF = 'verification.runner names codex, but there is no runners.codex block; the second pass stays off.';
const WITH_RUNNER = `${CODEX}\n  use:\n    challenge: codex\nverification:\n  enabled: true\n  runner: codex\nwatch:\n  run_repository_commands: true\n`;

for (const [via, label] of [['path', 'a path the caller passed as the operator choice'], ['env', 'an absolute REVIEW_VOICE_CONFIG'], ['flag', 'the review driver resolving --config'], ['driver-env', 'the review driver resolving an absolute REVIEW_VOICE_CONFIG, as watch hands it over']]) {
  test(`runners is honoured from the operator configuration (${label})`, () => {
    const config = load(WITH_RUNNER, via);
    assert.deepEqual(config.warnings, []);
    assert.equal(config.runners.use.challenge, 'codex');
    assert.equal(config.verification.enabled, true);
    assert.equal(config.verification.family, 'codex');
  });
}

for (const [via, label] of [['checkout', 'a plain checkout'], ['relative', 'a relative REVIEW_VOICE_CONFIG, which falls back to the checkout'], ['base', 'the base commit'], ['default', 'the defaults when the base has none']]) {
  test(`runners in a repository configuration is ignored with one warning that names the rule (${label})`, () => {
    const config = load(WITH_RUNNER, via);
    const fallback = via === 'relative' ? ['REVIEW_VOICE_CONFIG must be an absolute path; reading .review-voice/config.yaml instead.'] : [];
    assert.deepEqual(config.warnings, [...fallback, RULE, OFF]);
    assert.deepEqual(config.runners, { external: {}, use: DEFAULT_USE });
    assert.equal(config.verification.enabled, false, 'nothing from a repository can run a configured runner');
  });
}

test('verify in a checkout whose own config names a runner never runs it', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'rv-runners-verify-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  const ran = join(dir, 'ran');
  const stub = join(dir, 'stub.mjs');
  writeFileSync(stub, `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(ran)}, '');\nwriteFileSync(process.argv[2], JSON.stringify({ verdict: 'rejected', confidence: 0.9, reason: 'planted' }));\n`);
  mkdirSync(join(dir, '.review-voice'));
  writeFileSync(
    join(dir, '.review-voice', 'config.yaml'),
    ['runners:', '  codex:', `    command: [${JSON.stringify(process.execPath)}, ${JSON.stringify(stub)}, "{output}"]`, 'verification:', '  enabled: true', '  runner: codex', 'watch:', '  run_repository_commands: true', ''].join('\n'),
  );
  const env = { ...process.env };
  for (const name of ['REVIEW_VOICE_CONFIG', 'REVIEW_VOICE_CONFIG_SOURCE', 'REVIEW_VOICE_NO_COMMANDS']) delete env[name];
  const candidates = JSON.stringify({ candidates: [{ candidate_id: 'cand_001', path: 'src/a.ts', line: 1, severity: 'blocking', claim: 'x', failure_mode: 'y', evidence: ['z'] }] });
  const run = spawnSync(process.execPath, [bundle, 'verify'], { cwd: dir, encoding: 'utf8', input: candidates, env });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(JSON.parse(run.stdout).enabled, false, 'the second pass stays off');
  assert.equal(existsSync(ran), false, 'the checkout\'s own runner never ran');
});

// ---- a requested family is never replaced on a configuration error (D3) ----

test('a use value naming a family whose block is missing or rejected keeps that family, with the warning, so its challenges hold', () => {
  const kept = (family) => `names ${family}, but there is no runners.${family} block; every finding challenged on ${family} is held.`;
  const missing = load(`${CODEX}\n  use:\n    challenge: gemini\n    agent_authored_challenge: gemini\n`);
  assert.deepEqual(warned(missing, 'runners.use'), [`runners.use.challenge ${kept('gemini')}`, `runners.use.agent_authored_challenge ${kept('gemini')}`]);
  assert.deepEqual(missing.runners.use, { challenge: 'gemini', agentAuthoredChallenge: 'gemini' });
  assert.equal(missing.runners.external.gemini, undefined, 'no runner is invented for it');

  for (const [label, block] of [['an empty command', 'command: []'], ['a shell string', 'command: codex exec -']]) {
    const rejected = load(`runners:\n  codex:\n    ${block}\n  use:\n    challenge: codex\n`);
    assert.equal(rejected.runners.use.challenge, 'codex', label);
    assert.deepEqual(rejected.runners.external, {}, label);
    assert.deepEqual(warned(rejected, 'runners.use'), [`runners.use.challenge ${kept('codex')}`], label);
  }
});

const CHALLENGE_UNREADABLE = 'runners.use.challenge is not one of claude, codex, gemini';
const ALTERNATIVE_UNREADABLE = 'runners.use.agent_authored_challenge is not one of claude, codex, gemini';
const planFor = (runners, authorship) =>
  resolvePlan({ requested: 'standard', productionSourceChanged: true, productionLinesChanged: 10, complexity: 'normal', secondPassConfigured: false, runners, authorship }).families;
const agent = (family) => ({ agent: true, family, evidence: [] });

for (const [label, value] of [['a misspelt family', 'Codex'], ['a binary name', 'codex-cli'], ['a list', '[codex]'], ['a number', '7']]) {
  test(`a runners.use.challenge that is ${label} is unreadable, so the plan holds the challenge and names no fallback rule`, () => {
    const config = load(`${CODEX}\n  use:\n    challenge: ${value}\n`);
    assert.equal(config.runners.use.challengeUnreadable, CHALLENGE_UNREADABLE);
    assert.equal(warned(config, 'runners.use.challenge must be one of').length, 1);
    assert.equal(warned(config, 'using claude').length, 0, 'no warning says another family is used');
    assert.deepEqual(planFor(config.runners, undefined), { challenge: 'claude', reason: 'runners.use.challenge', notRun: CHALLENGE_UNREADABLE });
  });
}

test('a runners.use that is not a mapping is unreadable and holds the challenge, while an empty one asks for nothing', () => {
  const text = load(`${CODEX}\n  use: codex\n`);
  assert.deepEqual(warned(text, 'runners.use'), ['runners.use must be a mapping; the challenge does not run and every challenged finding is held until it is one.']);
  assert.deepEqual(planFor(text.runners, undefined), { challenge: 'claude', reason: 'runners.use.challenge', notRun: 'runners.use is not a mapping' });

  const empty = load(`${CODEX}\n  use:\n`);
  assert.deepEqual(warned(empty, 'runners.use'), ['runners.use must be a mapping; using the defaults.']);
  assert.deepEqual(empty.runners.use, DEFAULT_USE);
  assert.deepEqual(planFor(empty.runners, undefined), { challenge: 'claude', reason: 'default' });
});

test('an unreadable runners.use.agent_authored_challenge holds the challenge only where the rule would have applied', () => {
  const config = load(`${CODEX}\n  use:\n    agent_authored_challenge: Codex\n`);
  assert.deepEqual(config.runners.use, { ...DEFAULT_USE, agentAuthoredChallengeUnreadable: ALTERNATIVE_UNREADABLE });
  assert.deepEqual(warned(config, 'runners.use.agent_authored_challenge'), [
    'runners.use.agent_authored_challenge must be one of claude, codex, gemini; the challenge of a change an agent of the challenge family wrote does not run and its findings are held until it names one.',
  ]);
  assert.deepEqual(planFor(config.runners, agent('claude')), { challenge: 'claude', reason: 'runners.use.agent_authored_challenge', notRun: ALTERNATIVE_UNREADABLE });
  // The rule never applied to these, so the base family challenges them as a readable value would have left it.
  for (const authorship of [undefined, agent('codex'), agent('other'), { agent: false, family: null, evidence: [] }]) {
    assert.deepEqual(planFor(config.runners, authorship), { challenge: 'claude', reason: 'default' }, JSON.stringify(authorship));
  }
});

test('a readable use block carries no unreadable mark and plans as before', () => {
  const config = load(`${CODEX}\n  use:\n    challenge: claude\n    agent_authored_challenge: codex\n`);
  assert.deepEqual(config.runners.use, { challenge: 'claude', agentAuthoredChallenge: 'codex' });
  assert.deepEqual(planFor(config.runners, agent('claude')), { challenge: 'codex', reason: 'agent-authored by claude; challenged on codex (runners.use.agent_authored_challenge)' });
  assert.deepEqual(planFor(config.runners, undefined), { challenge: 'claude', reason: 'default' });
});
