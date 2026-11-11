/**
 * S17 part A: the command backend runs an agent on another model family
 * through a configured argv (docs/adr/0021, amended), under the same process
 * discipline as the Claude backend, and `doctor` only reports the families.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { COMMAND_RUNNER_PREAMBLE, runAgent, schemaForRunner, schemasDir } from '../plugins/review-voice/src/agents/runner.ts';
import { expandCommand } from '../plugins/review-voice/src/agents/command-cli.ts';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bundle = join(root, 'plugins/review-voice/dist/review-voice.mjs');
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
// $schema and a file $ref, as the shipped schemas carry, so the prepared schema differs from the raw one.
const SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: { answer: { type: 'string' }, category: { $ref: 'finding-category.schema.json' } },
};

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'rv-command-runner-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * A stand-in for an external CLI. Everything it needs arrives on argv, since
 * the backend gives it a minimal environment: --record <file> records what it
 * saw, --mode says how it behaves, --schema/--output/--cwd carry the tokens.
 */
function writeStub(dir) {
  const path = join(dir, 'runner-stub.mjs');
  writeFileSync(
    path,
    `#!/usr/bin/env node
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { spawn } from 'node:child_process';
const argv = process.argv.slice(2);
const value = (name) => { const i = argv.indexOf(name); return i === -1 ? undefined : argv[i + 1]; };
const mode = value('--mode') ?? 'ok';
const stdin = readFileSync(0, 'utf8');
const schema = value('--schema');
if (value('--record')) {
  writeFileSync(value('--record'), JSON.stringify({
    argv, cwd: process.cwd(), stdin, envKeys: Object.keys(process.env),
    schema: schema ? JSON.parse(readFileSync(schema, 'utf8')) : null, schemaPath: schema ?? null,
  }));
}
if (mode === 'ok') {
  console.log('thinking aloud');
  console.log(JSON.stringify({ draft: true }));
  if (value('--output')) writeFileSync(value('--output'), JSON.stringify({ answer: 'yes' }));
  else console.log(JSON.stringify({ answer: 'yes' }));
} else if (mode === 'stream') {
  console.log(JSON.stringify({ type: 'item.completed', answer: 'not the answer' }));
  console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1 } }));
} else if (mode === 'partial') {
  writeFileSync(value('--output'), JSON.stringify({ answer: 'partial' }));
  process.exit(2);
} else if (mode === 'leak') {
  process.stderr.write('auth failed for key ' + process.env.OPENAI_API_KEY);
  process.exit(1);
} else if (mode === 'leak-late') {
  process.stderr.write('x'.repeat(490) + process.env.OPENAI_API_KEY);
  process.exit(1);
} else if (mode === 'file') {
  writeFileSync(value('--output'), JSON.stringify({ answer: 'from the output file' }));
  console.log(JSON.stringify({ type: 'event', answer: 'not this one' }));
} else if (mode === 'secret') {
  console.log(JSON.stringify({ answer: process.env.OPENAI_API_KEY ?? 'unset' }));
} else if (mode === 'exit') {
  process.stderr.write('runner exploded');
  process.exit(3);
} else if (mode === 'garbage') {
  console.log('not json at all');
} else if (mode === 'quiet') {
  process.stderr.write('quota exceeded for this account');
} else if (mode === 'setsid') {
  // Detached is setsid: the descendant leaves the group the timeout kills and keeps the inherited stdout.
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { detached: true, stdio: ['ignore', 'inherit', 'inherit'] });
  writeFileSync(value('--pid') + '.tmp', JSON.stringify({ stub: process.pid, child: child.pid }));
  renameSync(value('--pid') + '.tmp', value('--pid'));
  setTimeout(() => {}, 60000);
} else if (mode === 'sleep') {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  writeFileSync(value('--pid') + '.tmp', JSON.stringify({ stub: process.pid, child: child.pid }));
  renameSync(value('--pid') + '.tmp', value('--pid'));
  setTimeout(() => {}, 60000);
}
`,
  );
  return path;
}

/** The spec of an agent run on a stub codex, with the tokens and the extra arguments the tests read back. */
function codexSpec(stub, extra = [], runner = {}) {
  return {
    name: 'diff-analyst',
    model: 'ignored',
    tools: ['Read', 'Grep', 'Glob', 'Bash(git:*)'],
    schema: SCHEMA,
    runner: {
      family: 'codex',
      label: 'codex-x',
      command: [process.execPath, stub, '--schema', '{schema}', '--output', '{output}', '--cwd', '{cwd}', '$HOME', ...extra],
      ...runner,
    },
  };
}

/** The same spec with no {output} token, so the answer is the last JSON object on stdout. */
function stdoutSpec(stub, extra = [], runner = {}) {
  const spec = codexSpec(stub, extra, runner);
  spec.runner.command = spec.runner.command.filter((argument) => argument !== '--output' && argument !== '{output}');
  return spec;
}

/** The parent's environment with the switches other tests may leave behind removed, plus secrets that must not reach the stub. */
function parentEnv(extra = {}) {
  const env = { ...process.env, GITHUB_TOKEN: 'ghp_placeholder', GH_TOKEN: 'gho_placeholder', ANTHROPIC_API_KEY: 'sk-ant-placeholder', REVIEW_VOICE_DATA_DIR: '/tmp/rv-data' };
  delete env.REVIEW_VOICE_FAKE_AGENTS;
  delete env.REVIEW_VOICE_AGENT_RUNNER;
  delete env.REVIEW_VOICE_NO_COMMANDS;
  return { ...env, ...extra };
}

const agentBody = (name) => readFileSync(join(root, 'plugins/review-voice/agents', `${name}.md`), 'utf8').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trim();

test('expandCommand replaces only whole-argument tokens', () => {
  const values = { schema: '/s.json', output: '/o.json', cwd: '/head' };
  assert.deepEqual(expandCommand(['run', '{schema}', 'x{cwd}', '{output}', '{cwd}', '{other}'], values), ['run', '/s.json', 'x{cwd}', '/o.json', '/head', '{other}']);
});

test('expandCommand passes an argument named after an Object.prototype member as written', () => {
  const values = { schema: '/s.json', output: '/o.json', cwd: '/head' };
  const names = ['toString', 'constructor', 'valueOf', 'hasOwnProperty', '__proto__'];
  assert.deepEqual(expandCommand(names, values), names);
});

test('AC-1: the command backend spawns the argv without a shell, with the schema file, the agent body and a minimal environment', async (t) => {
  const dir = tempDir(t);
  const stub = writeStub(dir);
  const record = join(dir, 'record.json');
  const cwd = join(dir, 'head');
  mkdirSync(cwd);

  const result = await runAgent(codexSpec(stub, ['--record', record]), 'find defects', cwd, ['/runs/base-a', '/runs/base-b'], parentEnv());

  assert.equal(result.ok, true, result.error);
  assert.deepEqual(result.output, { answer: 'yes' }, 'the {output} file carries the answer');
  assert.equal(result.costUsd, null);
  assert.equal(Object.hasOwn(result, 'tokens'), false, 'no count was reported, so there is no tokens key');
  assert.equal(typeof result.seconds, 'number');

  const seen = readJson(record);
  const value = (name) => seen.argv[seen.argv.indexOf(name) + 1];
  assert.ok(seen.argv.includes('$HOME'), 'no shell expanded the argument');
  assert.deepEqual(seen.schema, schemaForRunner(SCHEMA, schemasDir()), '{schema} names a file holding the prepared schema');
  assert.notDeepEqual(seen.schema, SCHEMA, 'the raw schema is not what the CLI gets');
  assert.ok(!/"\$(ref|schema)"/.test(JSON.stringify(seen.schema)), 'no $ref or $schema reaches an external CLI');
  assert.equal(value('--cwd'), cwd, '{cwd} is the working directory');
  assert.ok(value('--output').endsWith('output.json'), '{output} names a file');
  assert.equal(
    seen.stdin,
    `${agentBody('diff-analyst')}\n\n${COMMAND_RUNNER_PREAMBLE} Also readable: /runs/base-a, /runs/base-b\n\nfind defects`,
    'the agent body, the preamble and the prompt, in that order',
  );
  for (const gone of ['GITHUB_TOKEN', 'GH_TOKEN', 'ANTHROPIC_API_KEY', 'REVIEW_VOICE_DATA_DIR']) {
    assert.ok(!seen.envKeys.includes(gone), `${gone} is not passed`);
  }
  assert.ok(!seen.envKeys.some((key) => key.startsWith('REVIEW_VOICE_')), 'no REVIEW_VOICE_* key');
  for (const kept of ['PATH', 'HOME']) assert.ok(seen.envKeys.includes(kept), kept);
  assert.equal(existsSync(dirname(seen.schemaPath)), false, 'the temporary schema directory is removed');
});

test('AC-1: the answer is read from {output} in place of stdout when the command names it', async (t) => {
  const dir = tempDir(t);
  const stub = writeStub(dir);
  const result = await runAgent(codexSpec(stub, ['--mode', 'file']), 'x', dir, [], parentEnv());
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(result.output, { answer: 'from the output file' });
});

test('AC-1: a passed-through variable reaches the command and its value is masked in the answer', async (t) => {
  const dir = tempDir(t);
  const stub = writeStub(dir);
  const env = parentEnv({ OPENAI_API_KEY: 'openai-listed-value' });
  const listed = await runAgent(stdoutSpec(stub, ['--mode', 'secret'], { envPassthrough: ['OPENAI_API_KEY'] }), 'x', dir, [], env);
  assert.equal(listed.ok, true, listed.error);
  assert.deepEqual(listed.output, { answer: '[redacted:OPENAI_API_KEY]' });
  const unlisted = await runAgent(stdoutSpec(stub, ['--mode', 'secret']), 'x', dir, [], env);
  assert.deepEqual(unlisted.output, { answer: 'unset' }, 'nothing beyond the base names without a list');

  const failing = await runAgent(codexSpec(stub, ['--mode', 'leak'], { envPassthrough: ['OPENAI_API_KEY'] }), 'x', dir, [], env);
  assert.equal(failing.ok, false);
  assert.equal(failing.error, 'auth failed for key [redacted:OPENAI_API_KEY]', 'a failure that quotes the value is masked too');
});

test('AC-1: a passed-through value that straddles the 500-character cut of an error is masked before the cut', async (t) => {
  const dir = tempDir(t);
  const stub = writeStub(dir);
  const env = parentEnv({ OPENAI_API_KEY: 'openai-listed-value' });
  const failing = await runAgent(codexSpec(stub, ['--mode', 'leak-late'], { envPassthrough: ['OPENAI_API_KEY'] }), 'x', dir, [], env);
  assert.equal(failing.ok, false);
  assert.ok(!failing.error.includes('openai'), `no head of the value is reported: ${failing.error.slice(480)}`);
  assert.ok(failing.error.startsWith('x'.repeat(490) + '[redacted'), 'the masked text is what was cut');
});

test('AC-1: without {output} the last JSON object on stdout is the answer; with it, stdout is no substitute for the file', async (t) => {
  const dir = tempDir(t);
  const stub = writeStub(dir);
  const stdout = await runAgent(stdoutSpec(stub), 'x', dir, [], parentEnv());
  assert.equal(stdout.ok, true, stdout.error);
  assert.deepEqual(stdout.output, { answer: 'yes' });

  const stream = await runAgent(codexSpec(stub, ['--mode', 'stream']), 'x', dir, [], parentEnv());
  assert.equal(stream.ok, false, 'a stream event is not the answer');
  assert.equal(stream.output, null);
  assert.match(stream.error, /^\{"type":"item\.completed"/, 'with no stderr, stdout is the error, as the spec says');

  const partial = await runAgent(codexSpec(stub, ['--mode', 'partial']), 'x', dir, [], parentEnv());
  assert.equal(partial.ok, false, 'a valid object does not rescue a non-zero exit');
  assert.equal(partial.output, null);
  assert.match(partial.error, /exited with code 2$/);
});

test('AC-1: a non-zero exit, no JSON object and a missing binary each fail the call with the stated error', async (t) => {
  const dir = tempDir(t);
  const stub = writeStub(dir);
  const exit = await runAgent(codexSpec(stub, ['--mode', 'exit']), 'x', dir, [], parentEnv());
  assert.equal(exit.ok, false);
  assert.match(exit.error, /runner exploded/);
  assert.equal(exit.output, null);
  assert.equal(exit.costUsd, null);

  const garbage = await runAgent(stdoutSpec(stub, ['--mode', 'garbage']), 'x', dir, [], parentEnv());
  assert.equal(garbage.ok, false);
  assert.match(garbage.error, /not json at all/);

  const missing = await runAgent({ ...codexSpec(stub), runner: { family: 'codex', label: 'codex', command: [join(dir, 'no-such-runner'), '{schema}'] } }, 'x', dir, [], parentEnv());
  assert.equal(missing.ok, false);
  assert.match(missing.error, /no-such-runner/);
});

test('AC-1: a call past its timeout kills the process group and reports "timeout"', async (t) => {
  const dir = tempDir(t);
  const stub = writeStub(dir);
  const pidFile = join(dir, 'child.pid');
  const started = Date.now();
  const result = await runAgent({ ...codexSpec(stub, ['--mode', 'sleep', '--pid', pidFile]), timeoutMs: 700 }, 'x', dir, [], parentEnv());
  assert.equal(result.ok, false);
  assert.equal(result.error, 'timeout');
  assert.ok(Date.now() - started < 10_000, 'returned promptly');
  const pid = readJson(pidFile).child;
  let alive = true;
  for (let i = 0; i < 50 && alive; i += 1) {
    try {
      process.kill(pid, 0);
      await new Promise((resolve) => setTimeout(resolve, 20));
    } catch {
      alive = false;
    }
  }
  assert.equal(alive, false, 'the stub\'s child was killed too');
});

test('AC-1: a run that exits 0 without writing {output} reports its stderr, else the missing file', async (t) => {
  const dir = tempDir(t);
  const stub = writeStub(dir);
  const quiet = await runAgent(codexSpec(stub, ['--mode', 'quiet']), 'x', dir, [], parentEnv());
  assert.equal(quiet.ok, false);
  assert.equal(quiet.error, 'quota exceeded for this account', 'the reason on stderr is not dropped');

  const silent = await runAgent(codexSpec(stub, ['--mode', 'silent']), 'x', dir, [], parentEnv());
  assert.equal(silent.ok, false);
  assert.match(silent.error, /wrote no \{output\} file$/);
});

test('AC-1: a timeout ends the call even when a descendant left the process group holding stdout', { timeout: 30_000 }, async (t) => {
  const dir = tempDir(t);
  const stub = writeStub(dir);
  const pidFile = join(dir, 'child.pid');
  t.after(() => {
    try {
      process.kill(readJson(pidFile).child, 'SIGKILL');
    } catch {
      // Already gone, or the stub never started it.
    }
  });
  const started = Date.now();
  const result = await runAgent({ ...codexSpec(stub, ['--mode', 'setsid', '--pid', pidFile]), timeoutMs: 700 }, 'x', dir, [], parentEnv());
  assert.equal(result.ok, false);
  assert.equal(result.error, 'timeout');
  assert.ok(Date.now() - started < 10_000, 'returned promptly, not when the descendant let go of stdout');
});

test('AC-1: a stop signal removes the temporary schema directory before the process exits', { timeout: 30_000 }, async (t) => {
  const dir = tempDir(t);
  const stub = writeStub(dir);
  const pidFile = join(dir, 'child.pid');
  const record = join(dir, 'record.json');
  const script = join(dir, 'run-agent.mjs');
  const runnerUrl = new URL('../plugins/review-voice/src/agents/runner.ts', import.meta.url).href;
  writeFileSync(
    script,
    `import { runAgent } from ${JSON.stringify(runnerUrl)};
const spec = ${JSON.stringify(codexSpec(stub, ['--mode', 'sleep', '--pid', pidFile, '--record', record]))};
await runAgent(spec, 'x', ${JSON.stringify(dir)}, [], process.env);
`,
  );
  const child = spawn(process.execPath, [script], { env: parentEnv(), stdio: 'ignore' });
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve(code ?? signal)));
  for (let i = 0; i < 500 && !existsSync(pidFile); i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
  const schemaDir = dirname(readJson(record).schemaPath);
  assert.equal(existsSync(schemaDir), true, 'the directory exists while the runner runs');
  child.kill('SIGTERM');
  assert.equal(await exited, 143);
  assert.equal(existsSync(schemaDir), false, 'the signal path removed it');
});

test('AC-1: REVIEW_VOICE_NO_COMMANDS=1 keeps the runner from starting', async (t) => {
  const dir = tempDir(t);
  const stub = writeStub(dir);
  const record = join(dir, 'record.json');
  const result = await runAgent(codexSpec(stub, ['--record', record]), 'x', dir, [], parentEnv({ REVIEW_VOICE_NO_COMMANDS: '1' }));
  assert.equal(result.ok, false);
  assert.equal(result.error, 'REVIEW_VOICE_NO_COMMANDS=1 keeps the configured codex runner from running');
  assert.equal(existsSync(record), false, 'the stub never ran');
});

test('AC-1: REVIEW_VOICE_FAKE_AGENTS wins over the runner, and the fake records the family, the label and the preamble', async (t) => {
  const dir = tempDir(t);
  const stub = writeStub(dir);
  const fakes = join(dir, 'fakes');
  mkdirSync(fakes);
  writeFileSync(join(fakes, 'diff-analyst.1.json'), JSON.stringify({ output: { answer: 'canned' } }));
  const record = join(dir, 'record.json');
  const result = await runAgent(codexSpec(stub, ['--record', record]), 'x', dir, [], parentEnv({ REVIEW_VOICE_FAKE_AGENTS: fakes }));
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(result.output, { answer: 'canned' });
  assert.equal(existsSync(record), false, 'the stub never ran');
  const spec = readJson(join(fakes, '.calls', 'diff-analyst.1.spec.json'));
  assert.deepEqual(spec.runner, { family: 'codex', label: 'codex-x' });
  const prompt = readFileSync(join(fakes, '.calls', 'diff-analyst.1.prompt.txt'), 'utf8');
  assert.ok(prompt.startsWith(`${COMMAND_RUNNER_PREAMBLE}\n\nx`), prompt.slice(0, 120));

  // Without a runner the fake's spec carries no runner key, so existing assertions hold.
  await runAgent({ name: 'diff-analyst', model: 'haiku', tools: ['Read'], schema: SCHEMA }, 'y', dir, [], parentEnv({ REVIEW_VOICE_FAKE_AGENTS: fakes }));
  assert.equal(Object.hasOwn(readJson(join(fakes, '.calls', 'diff-analyst.2.spec.json')), 'runner'), false);
});

// ---- AC-5: doctor ----------------------------------------------------------

/** A PATH holding only git and node, plus whatever `extra` names, so codex and gemini are present only when written there. */
function pathWith(dir, extra = {}) {
  const bin = join(dir, 'bin');
  mkdirSync(bin, { recursive: true });
  for (const tool of ['git', 'node']) {
    const real = execFileSync('which', [tool], { encoding: 'utf8' }).trim();
    symlinkSync(real, join(bin, tool));
  }
  for (const [name, version] of Object.entries(extra)) {
    writeFileSync(join(bin, name), `#!/bin/sh\necho '${version}'\n`);
    chmodSync(join(bin, name), 0o755);
  }
  return bin;
}

const doctor = (env, cwd = undefined) => spawnSync(process.execPath, [bundle, 'doctor'], { encoding: 'utf8', env: { ...process.env, ...env }, ...(cwd === undefined ? {} : { cwd }) });

test('AC-5: doctor reports codex and gemini as informational, present or absent, and exits 0 either way', (t) => {
  const dir = tempDir(t);
  const present = doctor({ PATH: pathWith(join(dir, 'present'), { codex: 'codex-cli 1.2.3', gemini: 'gemini 0.9.0' }) });
  assert.equal(present.status, 0, present.stderr);
  assert.match(present.stdout, /codex\s+found \(used only when runners\.codex is configured\): codex-cli 1\.2\.3/);
  assert.match(present.stdout, /gemini\s+found \(used only when runners\.gemini is configured\): gemini 0\.9\.0/);

  const absent = doctor({ PATH: pathWith(join(dir, 'absent')) });
  assert.equal(absent.status, 0, `a missing family does not fail doctor: ${absent.stderr}`);
  assert.match(absent.stdout, /codex\s+not found on PATH \(needed only when runners\.codex is configured\)/);
  assert.match(absent.stdout, /gemini\s+not found on PATH \(needed only when runners\.gemini is configured\)/);
});

test('AC-5: doctor never runs a configured runners.<family>.command', (t) => {
  const dir = tempDir(t);
  // command[0] is an executable stub that records every call, whatever its arguments.
  const record = join(dir, 'record.txt');
  const stub = join(dir, 'family-stub');
  writeFileSync(stub, `#!/bin/sh\necho "$@" >> '${record}'\n`);
  chmodSync(stub, 0o755);
  execFileSync(stub, ['--version']);
  assert.equal(existsSync(record), true, 'the stub records a call, so a run would show');
  rmSync(record);

  // Handed over as an operator hands it, so a doctor that loaded runners: would see the block.
  const yaml = `runners:\n  codex:\n    command: ["${stub}", "exec", "-"]\n  gemini:\n    command: ["${stub}"]\n`;
  const operator = join(dir, 'operator.yaml');
  writeFileSync(operator, yaml);
  const repo = join(dir, 'repo');
  mkdirSync(join(repo, '.review-voice'), { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: repo });
  writeFileSync(join(repo, '.review-voice', 'config.yaml'), yaml);
  const result = doctor({ PATH: pathWith(join(dir, 'path')), REVIEW_VOICE_CONFIG: operator }, repo);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(record), false, 'the configured command was not run');
});
