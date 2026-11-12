/**
 * #279. Configured commands ran with the review process's whole environment.
 * Since a command runs in the pull request's head tree, one that delegates to
 * the tree handed the author's code GITHUB_TOKEN, ANTHROPIC_API_KEY and
 * REVIEW_VOICE_* settings. They now get a minimal environment plus the names a
 * repository lists under env_passthrough.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { commandEnvironment } from '../plugins/review-voice/src/evidence/run.ts';
import { loadConfig } from '../plugins/review-voice/src/policy/load.ts';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bundle = join(root, 'plugins/review-voice/dist/review-voice.mjs');

const SECRETS = {
  GITHUB_TOKEN: 'ghp_parent_token_must_not_leak',
  ANTHROPIC_API_KEY: 'sk-ant-parent-key-must-not-leak',
};

function temporary(t, prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A repository whose config is the given object, written as JSON (valid YAML). */
function repoWith(t, config) {
  const dir = temporary(t, 'rv-279-repo-');
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  mkdirSync(join(dir, '.review-voice'));
  writeFileSync(join(dir, '.review-voice', 'config.yaml'), JSON.stringify(config, null, 2));
  return dir;
}

/** Runs the bundle with the secrets and a Review Voice setting in the parent's environment. */
function cli(t, cwd, args, input = '') {
  const env = {
    ...process.env,
    ...SECRETS,
    NPM_TOKEN: 'npm-listed-value',
    OPENAI_API_KEY: 'openai-listed-value',
    REVIEW_VOICE_NO_COMMANDS: '0',
    REVIEW_VOICE_DATA_DIR: temporary(t, 'rv-279-data-'),
  };
  delete env.REVIEW_VOICE_CONFIG;
  return JSON.parse(execFileSync(process.execPath, [bundle, ...args], { cwd, encoding: 'utf8', input, env }));
}

/** `env` output as a map, so a value is checked by name rather than by substring. */
function readEnv(path) {
  const entries = readFileSync(path, 'utf8').split('\n').filter((line) => line.includes('='));
  return new Map(entries.map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
}

function assertScrubbed(env) {
  for (const name of ['GITHUB_TOKEN', 'ANTHROPIC_API_KEY', 'REVIEW_VOICE_DATA_DIR', 'REVIEW_VOICE_NO_COMMANDS']) {
    assert.equal(env.has(name), false, `${name} reached the command`);
  }
  for (const value of Object.values(SECRETS)) {
    assert.equal([...env.values()].some((v) => v.includes(value)), false, 'a parent secret reached the command');
  }
  assert.equal(env.get('PATH'), process.env.PATH, 'PATH is passed as it is');
}

test('the helper keeps only the base names, plus exactly the listed ones', () => {
  const source = {
    PATH: '/usr/bin:/bin',
    HOME: '/home/reviewer',
    GITHUB_TOKEN: 'ghp_x',
    ANTHROPIC_API_KEY: 'sk-ant-x',
    REVIEW_VOICE_CONFIG: '/trusted/config.yaml',
    NPM_TOKEN: 'npm_x',
    FOO: 'bar',
  };
  assert.deepEqual(commandEnvironment(source, []), { PATH: '/usr/bin:/bin', HOME: '/home/reviewer' });
  assert.deepEqual(commandEnvironment(source, ['NPM_TOKEN', 'GITHUB_TOKEN']), {
    PATH: '/usr/bin:/bin', HOME: '/home/reviewer', NPM_TOKEN: 'npm_x', GITHUB_TOKEN: 'ghp_x',
  });
  const unset = commandEnvironment(source, ['NOT_SET']);
  assert.equal(Object.hasOwn(unset, 'NOT_SET'), false, 'an unset listed name is absent, not empty');
});

test('evidence commands and their version commands get the minimal environment and the listed names', (t) => {
  const out = temporary(t, 'rv-279-out-');
  const runEnv = join(out, 'run.env');
  const versionEnv = join(out, 'version.env');
  const dir = repoWith(t, {
    static_evidence: {
      enabled: true,
      env_passthrough: ['NPM_TOKEN'],
      commands: [{ name: 'probe', run: `env > '${runEnv}'`, version: `env > '${versionEnv}'; echo probe 1.0` }],
    },
  });
  const report = cli(t, dir, ['evidence']);
  assert.equal(report.commands[0].exitCode, 0, 'the command ran, so PATH still resolves tools');
  assert.equal(report.commands[0].version, 'probe 1.0');
  assert.deepEqual(report.didNotRun, []);

  const run = readEnv(runEnv);
  assertScrubbed(run);
  assert.equal(run.get('NPM_TOKEN'), 'npm-listed-value', 'a listed name is passed');
  assert.equal(run.has('OPENAI_API_KEY'), false, 'a name listed only for verification is not passed');
  assert.deepEqual(readEnv(versionEnv), run, 'the version command gets the same environment');
});

test('the verification command gets the minimal environment and its own list', (t) => {
  const out = temporary(t, 'rv-279-out-');
  const verifyEnv = join(out, 'verify.env');
  const verdict = JSON.stringify({ verdict: 'confirmed', confidence: 0.9, reason: 'holds' });
  const dir = repoWith(t, {
    static_evidence: { enabled: false, env_passthrough: ['NPM_TOKEN'], commands: [] },
    verification: { enabled: true, command: `env > '${verifyEnv}'; echo '${verdict}'`, env_passthrough: ['OPENAI_API_KEY'] },
  });
  const candidate = {
    candidateId: 'cand_001', path: 'src/a.ts', line: 1, severity: 'minor',
    claim: 'c', failureMode: 'f', evidence: ['e'],
  };
  const report = cli(t, dir, ['verify'], JSON.stringify({ candidates: [candidate] }));
  assert.equal(report.verdicts[0].verdict, 'confirmed', 'the command ran and answered');

  const env = readEnv(verifyEnv);
  assertScrubbed(env);
  assert.equal(env.get('OPENAI_API_KEY'), 'openai-listed-value', 'a listed name is passed');
  assert.equal(env.has('NPM_TOKEN'), false, 'a name listed only for static evidence is not passed');
});

test('a bad env_passthrough name and a non-list each warn and are dropped', (t) => {
  const dir = repoWith(t, {
    static_evidence: { enabled: true, commands: [], env_passthrough: ['NPM_TOKEN', '1BAD', 'HAS-DASH', 'A=B', 7, ''] },
    verification: { enabled: false, command: '', env_passthrough: 'OPENAI_API_KEY' },
  });
  const config = loadConfig(dir);
  assert.deepEqual(config.staticEvidence.envPassthrough, ['NPM_TOKEN']);
  assert.deepEqual(config.verification.envPassthrough, []);
  const warnings = config.warnings;
  assert.equal(warnings.filter((w) => w.startsWith('static_evidence.env_passthrough: ')).length, 5, warnings.join('\n'));
  assert.ok(warnings.includes('verification.env_passthrough must be a list of variable names; ignoring it.'), warnings.join('\n'));
  assert.equal(warnings.length, 6, warnings.join('\n'));
});

test('without env_passthrough both lists default to empty and nothing warns', (t) => {
  const dir = repoWith(t, { static_evidence: { enabled: true, commands: [] }, verification: { enabled: false, command: '' } });
  const config = loadConfig(dir);
  assert.deepEqual(config.staticEvidence.envPassthrough, []);
  assert.deepEqual(config.verification.envPassthrough, []);
  assert.deepEqual(config.warnings, []);
});

// A listed variable is often a token, and a tool that prints it must not carry it into the report.
test('a passed-through value a command prints is masked in the evidence report and the version line', (t) => {
  const tsc = "printf 'src/a.ts(1,1): error TS2345: token %s rejected\\n' \"$NPM_TOKEN\"";
  const dir = repoWith(t, {
    static_evidence: {
      enabled: true,
      env_passthrough: ['NPM_TOKEN'],
      commands: [{ name: 'tsc', run: tsc, version: 'printf "tool 1.0 %s\\n" "$NPM_TOKEN"' }],
    },
  });
  const report = cli(t, dir, ['evidence']);
  const text = JSON.stringify(report);
  assert.equal(text.includes('npm-listed-value'), false, 'the value appears nowhere in the report');
  assert.equal(report.commands[0].version, 'tool 1.0 [redacted:NPM_TOKEN]');
  assert.match(report.signals[0].claim, /token \[redacted:NPM_TOKEN\] rejected/);
});

test('a passed-through value the verifier quotes in its reason is masked', (t) => {
  const verdict = '{"verdict":"confirmed","confidence":0.9,"reason":"called with %s"}';
  const dir = repoWith(t, {
    verification: { enabled: true, command: `printf '${verdict}\\n' "$OPENAI_API_KEY"`, env_passthrough: ['OPENAI_API_KEY'] },
  });
  const report = cli(t, dir, ['verify'], JSON.stringify({ candidates: [{ candidate_id: 'cand_001', path: 'src/a.ts', line: 1, severity: 'minor', claim: 'x', failure_mode: 'y', evidence: ['src/a.ts:1'] }] }));
  assert.equal(JSON.stringify(report).includes('openai-listed-value'), false);
  assert.match(JSON.stringify(report), /called with \[redacted:OPENAI_API_KEY\]/);
});

test('masking leaves short values and the base variables alone', async () => {
  const { maskPassthrough } = await import('../plugins/review-voice/src/evidence/run.ts');
  const source = { PATH: '/usr/bin', FLAG: 'true', TOKEN: 'abcdefgh12' };
  assert.equal(maskPassthrough('PATH=/usr/bin flag true token abcdefgh12', source, ['FLAG', 'TOKEN']), 'PATH=/usr/bin flag true token [redacted:TOKEN]');
});

// The ways a value escaped the first mask: JSON escaping, the version cap, and a path the mask corrupted.
test('a passed-through value is masked after decoding, before the version is cut, and never in a diagnostic path', (t) => {
  const long = 'x'.repeat(40) + '"q\\b' + 'y'.repeat(30);
  const versionDir = repoWith(t, {
    static_evidence: { enabled: true, env_passthrough: ['PROBE_TOKEN'], commands: [{ name: 'tsc', run: 'true', version: 'printf "Tool 1.0 %s\\nsecond %s\\n" "$PROBE_TOKEN" "$PROBE_TOKEN"' }] },
  });
  const env = { ...process.env, PROBE_TOKEN: long, REVIEW_VOICE_NO_COMMANDS: '0', REVIEW_VOICE_DATA_DIR: temporary(t, 'rv-279-data-') };
  delete env.REVIEW_VOICE_CONFIG;
  const run = (cwd, args, input = '') => JSON.parse(execFileSync(process.execPath, [bundle, ...args], { cwd, encoding: 'utf8', input, env }));
  const version = run(versionDir, ['evidence']).commands[0].version;
  assert.equal(version, 'Tool 1.0 [redacted:PROBE_TOKEN]');
  assert.equal(version.includes('xxxxxxxx'), false, 'no prefix of the value survives the cap');

  const verdict = "node -e 'process.stdout.write(JSON.stringify({ verdict: \"confirmed\", confidence: 0.9, reason: \"saw \" + process.env.PROBE_TOKEN }))'";
  const verifyDir = repoWith(t, { verification: { enabled: true, command: verdict, env_passthrough: ['PROBE_TOKEN'] } });
  const report = run(verifyDir, ['verify'], JSON.stringify({ candidates: [{ candidate_id: 'cand_001', path: 'src/a.ts', line: 1, severity: 'minor', claim: 'x', failure_mode: 'y', evidence: ['src/a.ts:1'] }] }));
  assert.equal(JSON.stringify(report).includes('yyyyyyyy'), false, 'a JSON-escaped value is masked once decoded');
  assert.match(report.verdicts[0].reason, /saw \[redacted:PROBE_TOKEN\]/);

  const pathDir = repoWith(t, {
    static_evidence: { enabled: true, env_passthrough: ['SRC_ROOT'], commands: [{ name: 'tsc', run: 'printf "%s/src/app.ts(3,1): error TS2345: bad\\n" "$SRC_ROOT"' }] },
  });
  const pathEnv = { ...env, SRC_ROOT: pathDir };
  const signals = JSON.parse(execFileSync(process.execPath, [bundle, 'evidence'], { cwd: pathDir, encoding: 'utf8', env: pathEnv })).signals;
  assert.deepEqual([signals[0].path, signals[0].line], [null, null], 'a path carrying a passed-through value is dropped with its line, since a masked one would name another file');
  assert.equal(signals[0].evidence[0], '[redacted:SRC_ROOT]/src/app.ts(3,1): error TS2345: bad');
  assert.equal(JSON.stringify(signals).includes(pathDir), false);
});
