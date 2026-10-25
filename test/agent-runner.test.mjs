/**
 * The agent runner (docs/adr/0021): one confined headless Claude Code process
 * per agent call, a fake backend for tests, and the `agent` command. The
 * claude-cli backend is exercised against a stub binary, never a real model.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAgentTools } from '../plugins/review-voice/src/agents/tools.ts';
import {
  agentsDir,
  readAgentTools,
  runAgent,
  runAgents,
  RUNNER_PREAMBLE,
  schemaForRunner,
  agentTimeoutMs,
  MAX_STDOUT_BYTES,
} from '../plugins/review-voice/src/agents/runner.ts';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bundle = join(root, 'plugins/review-voice/dist/review-voice.mjs');
const pluginAgents = join(root, 'plugins/review-voice/agents');
const pluginSchemas = join(root, 'plugins/review-voice/schemas');
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

const SCHEMA = { type: 'object', properties: { answer: { type: 'string' } } };

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'rv-agent-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * A stand-in for `claude`. It records argv, cwd, stdin and the environment it
 * saw, then behaves as STUB_MODE says. The prompt may carry a JSON object with
 * `sleep` (ms) and `i`, so parallel tests can stagger and identify calls.
 */
function writeStub(dir) {
  const path = join(dir, 'claude-stub.mjs');
  writeFileSync(
    path,
    `#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
const argv = process.argv.slice(2);
const mode = process.env.STUB_MODE ?? 'ok';
if (argv[0] === '--version') { console.log('9.9.9 (Stub Code)'); process.exit(0); }
const prompt = readFileSync(0, 'utf8');
if (process.env.STUB_RECORD) {
  writeFileSync(process.env.STUB_RECORD, JSON.stringify({
    argv, cwd: process.cwd(), stdin: prompt, envKeys: Object.keys(process.env),
    apiKey: process.env.ANTHROPIC_API_KEY ?? null,
  }));
}
let meta = {};
try { meta = JSON.parse(prompt.split('\\n').at(-1)); } catch {}
if (process.env.STUB_EVENTS) appendFileSync(process.env.STUB_EVENTS, 'S\\n');
const finish = () => {
  if (process.env.STUB_EVENTS) appendFileSync(process.env.STUB_EVENTS, 'E\\n');
  if (mode === 'ok') {
    console.log(JSON.stringify({ type: 'result', is_error: false, result: 'done',
      structured_output: { answer: 'yes', i: meta.i ?? null }, total_cost_usd: 0.0123 }));
  } else if (mode === 'is-error') {
    console.log(JSON.stringify({ type: 'result', is_error: true, result: 'schema not satisfied' }));
  } else if (mode === 'exit') {
    process.stderr.write('stub exploded');
    process.exit(3);
  } else if (mode === 'garbage') {
    console.log('not json at all');
  }
};
if (mode === 'sleep') {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  writeFileSync(process.env.STUB_CHILD_PID, JSON.stringify({ stub: process.pid, child: child.pid }));
  setTimeout(() => {}, 60000);
} else if (mode === 'flood') {
  const chunk = Buffer.alloc(1 << 20, 120);
  const pump = () => { while (process.stdout.write(chunk)) {} process.stdout.once('drain', pump); };
  pump();
} else {
  setTimeout(finish, meta.sleep ?? 0);
}
`,
  );
  chmodSync(path, 0o755);
  return path;
}

function stubEnv(stub, extra = {}) {
  const env = { ...process.env, REVIEW_VOICE_CLAUDE_BIN: stub, ...extra };
  delete env.REVIEW_VOICE_FAKE_AGENTS;
  delete env.REVIEW_VOICE_AGENT_RUNNER;
  if (!('ANTHROPIC_API_KEY' in extra)) delete env.ANTHROPIC_API_KEY;
  return env;
}

const analyst = { name: 'diff-analyst', model: 'haiku', tools: ['Read', 'Grep', 'Glob', 'Bash(git:*)'], schema: SCHEMA };

function valueAfter(argv, name) {
  const index = argv.indexOf(name);
  return index === -1 ? undefined : argv[index + 1];
}

test('claude-cli backend runs a confined process with read-only file tools and no shell', async (t) => {
  const dir = tempDir(t);
  const stub = writeStub(dir);
  const clone = join(dir, 'clone');
  mkdirSync(clone);
  const record = join(dir, 'record.json');

  const result = await runAgent(
    analyst,
    'find defects',
    clone,
    ['/runs/base-a', '/runs/base-b'],
    stubEnv(stub, { STUB_RECORD: record }),
  );

  assert.equal(result.ok, true, result.error);
  assert.deepEqual(result.output, { answer: 'yes', i: null });
  assert.equal(result.costUsd, 0.0123);
  assert.equal(typeof result.seconds, 'number');

  const seen = JSON.parse(readFileSync(record, 'utf8'));
  const { argv } = seen;
  assert.equal(seen.stdin, `${RUNNER_PREAMBLE}\n\nfind defects`, 'preamble first, prompt on stdin');
  assert.equal(argv[0], '-p');
  assert.ok(argv[1].startsWith('--'), 'no positional prompt');
  assert.ok(!argv.some((arg) => arg.includes('find defects')));
  assert.match(RUNNER_PREAMBLE, /Shell and git are not available in this run/);
  for (const required of ['--restricted', '--safe-mode', '--strict-mcp-config', '--no-session-persistence']) {
    assert.ok(argv.includes(required), `${required} is passed`);
  }
  assert.equal(valueAfter(argv, '--tools'), 'Read,Grep,Glob');
  assert.equal(valueAfter(argv, '--allowedTools'), 'Read,Grep,Glob');
  assert.deepEqual(argv.filter((arg) => arg.includes('Bash')), [], 'no Bash anywhere on the command line');
  const addDirs = argv.flatMap((arg, index) => (argv[index - 1] === '--add-dir' ? [arg] : []));
  assert.deepEqual(addDirs, ['/runs/base-a', '/runs/base-b']);
  assert.equal(valueAfter(argv, '--system-prompt-file'), join(pluginAgents, 'diff-analyst.md'));
  assert.equal(valueAfter(argv, '--model'), 'haiku');
  assert.deepEqual(JSON.parse(valueAfter(argv, '--json-schema')), SCHEMA);
  assert.equal(valueAfter(argv, '--output-format'), 'json');
  assert.ok(!argv.includes('--bare'), '--bare only with an API key');
  assert.equal(seen.cwd, realpath(clone));
});

function realpath(path) {
  // macOS temp dirs live behind a /var -> /private/var symlink.
  return execFileSync('pwd', ['-P'], { cwd: path, encoding: 'utf8' }).trim();
}

test('claude-cli backend adds --bare when ANTHROPIC_API_KEY is set', async (t) => {
  const dir = tempDir(t);
  const stub = writeStub(dir);
  const record = join(dir, 'record.json');
  const result = await runAgent(
    analyst,
    'x',
    dir,
    [],
    stubEnv(stub, { STUB_RECORD: record, ANTHROPIC_API_KEY: 'placeholder' }),
  );
  assert.equal(result.ok, true, result.error);
  assert.ok(JSON.parse(readFileSync(record, 'utf8')).argv.includes('--bare'));
});

test('an agent that declares no tools gets an empty --tools and no --allowedTools', async (t) => {
  const dir = tempDir(t);
  const stub = writeStub(dir);
  const record = join(dir, 'record.json');
  const editor = { name: 'concise-editor', model: 'haiku', tools: [], schema: SCHEMA };
  const result = await runAgent(editor, 'x', dir, [], stubEnv(stub, { STUB_RECORD: record }));
  assert.equal(result.ok, true, result.error);
  const { argv } = JSON.parse(readFileSync(record, 'utf8'));
  assert.equal(valueAfter(argv, '--tools'), '');
  assert.ok(!argv.includes('--allowedTools'));
});

test('every prompt goes on stdin intact: large, flag-like, slash-led or holding a NUL', async (t) => {
  const dir = tempDir(t);
  const stub = writeStub(dir);
  const record = join(dir, 'record.json');
  for (const prompt of ['x'.repeat(100 * 1024 + 1), '--help', '/x run this', 'before\u0000after']) {
    const result = await runAgent(analyst, prompt, dir, [], stubEnv(stub, { STUB_RECORD: record }));
    assert.equal(result.ok, true, result.error);
    const seen = readJson(record);
    assert.equal(seen.stdin, `${RUNNER_PREAMBLE}\n\n${prompt}`);
    assert.equal(seen.argv[0], '-p');
    assert.ok(seen.argv[1].startsWith('--'), 'no positional prompt follows -p');
    assert.ok(!seen.argv.includes(prompt));
  }
});

test('the child environment drops GitHub tokens and REVIEW_VOICE_* but keeps the rest', async (t) => {
  const dir = tempDir(t);
  const stub = writeStub(dir);
  const record = join(dir, 'record.json');
  const result = await runAgent(
    analyst,
    'x',
    dir,
    [],
    stubEnv(stub, {
      STUB_RECORD: record,
      GITHUB_TOKEN: 'placeholder',
      GH_TOKEN: 'placeholder',
      REVIEW_VOICE_DATA_DIR: dir,
      ANTHROPIC_API_KEY: 'placeholder',
      HTTPS_PROXY: 'http://proxy.invalid:3128',
    }),
  );
  assert.equal(result.ok, true, result.error);
  const { envKeys, apiKey } = readJson(record);
  for (const gone of ['GITHUB_TOKEN', 'GH_TOKEN', 'REVIEW_VOICE_DATA_DIR', 'REVIEW_VOICE_CLAUDE_BIN']) {
    assert.ok(!envKeys.includes(gone), `${gone} is not passed`);
  }
  for (const kept of ['PATH', 'HOME', 'HTTPS_PROXY', 'ANTHROPIC_API_KEY']) assert.ok(envKeys.includes(kept), kept);
  assert.equal(apiKey, 'placeholder');
});

test('output past 32 MiB kills the process and fails with "output too large"', async (t) => {
  const dir = tempDir(t);
  const stub = writeStub(dir);
  const result = await runAgent(analyst, 'x', dir, [], stubEnv(stub, { STUB_MODE: 'flood' }));
  assert.equal(result.ok, false);
  assert.equal(result.error, 'output too large');
  assert.equal(MAX_STDOUT_BYTES, 32 * 1024 * 1024);
});

test('a timeout is capped at an hour', () => {
  assert.equal(agentTimeoutMs({ ...analyst }), 600_000);
  assert.equal(agentTimeoutMs({ ...analyst, timeoutMs: 5000 }), 5000);
  // Past 2^31-1 ms setTimeout fires at once, so an uncapped value would time out immediately.
  assert.equal(agentTimeoutMs({ ...analyst, timeoutMs: 10 * 3_600_000 }), 3_600_000);
});

test('an is_error envelope, a non-zero exit and non-JSON stdout all fail', async (t) => {
  const dir = tempDir(t);
  const stub = writeStub(dir);

  const isError = await runAgent(analyst, 'x', dir, [], stubEnv(stub, { STUB_MODE: 'is-error' }));
  assert.equal(isError.ok, false);
  assert.match(isError.error, /schema not satisfied/);

  const exit = await runAgent(analyst, 'x', dir, [], stubEnv(stub, { STUB_MODE: 'exit' }));
  assert.equal(exit.ok, false);
  assert.match(exit.error, /stub exploded/);

  const garbage = await runAgent(analyst, 'x', dir, [], stubEnv(stub, { STUB_MODE: 'garbage' }));
  assert.equal(garbage.ok, false);
  assert.match(garbage.error, /not json at all/);
});

test('a missing binary fails the call instead of throwing', async (t) => {
  const dir = tempDir(t);
  const result = await runAgent(analyst, 'x', dir, [], stubEnv(join(dir, 'no-such-claude')));
  assert.equal(result.ok, false);
  assert.match(result.error, /no-such-claude/);
});

test('a call past its timeout kills the process tree and reports "timeout"', async (t) => {
  const dir = tempDir(t);
  const stub = writeStub(dir);
  const childPid = join(dir, 'child.pid');
  const started = Date.now();
  const result = await runAgent(
    { ...analyst, timeoutMs: 700 },
    'x',
    dir,
    [],
    stubEnv(stub, { STUB_MODE: 'sleep', STUB_CHILD_PID: childPid }),
  );
  assert.equal(result.ok, false);
  assert.equal(result.error, 'timeout');
  assert.ok(Date.now() - started < 10_000, 'returned promptly');

  const pid = readJson(childPid).child;
  // The grandchild belongs to the killed group; give the kernel a moment.
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

test('a declared tool beyond Read, Grep, Glob and host-only git is refused without spawning', async (t) => {
  const dir = tempDir(t);
  const stub = writeStub(dir);
  for (const [n, tool] of ['Write', 'Edit', 'WebFetch', 'Bash', 'Bash(rm:*)', 'Bash(git push:*)'].entries()) {
    const record = join(dir, `record-${n}.json`);
    const result = await runAgent(
      { ...analyst, tools: ['Read', tool] },
      'x',
      dir,
      [],
      stubEnv(stub, { STUB_RECORD: record }),
    );
    assert.equal(result.ok, false, tool);
    assert.match(result.error, /grants only Read, Grep, Glob/);
    assert.equal(existsSync(record), false, `${tool}: the stub never ran`);
  }
});

test('runAgents keeps input order and never exceeds the parallel limit', async (t) => {
  const dir = tempDir(t);
  const stub = writeStub(dir);
  const events = join(dir, 'events.log');
  const env = stubEnv(stub, { STUB_EVENTS: events });
  // Earlier calls sleep longer, so finishing order is the reverse of input order.
  const calls = [0, 1, 2, 3, 4, 5].map((i) => ({
    spec: analyst,
    prompt: JSON.stringify({ i, sleep: 400 - i * 60 }),
    cwd: dir,
    env,
  }));

  const results = await runAgents(calls, 2);

  assert.deepEqual(
    results.map((r) => r.output.i),
    [0, 1, 2, 3, 4, 5],
  );
  let active = 0;
  let peak = 0;
  for (const event of readFileSync(events, 'utf8').trim().split('\n')) {
    active += event === 'S' ? 1 : -1;
    peak = Math.max(peak, active);
  }
  assert.equal(peak, 2, 'ran two at a time, never more');
});

function refsIn(node, found = []) {
  if (Array.isArray(node)) node.forEach((item) => refsIn(item, found));
  else if (node !== null && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      if (key === '$ref') found.push(value);
      refsIn(value, found);
    }
  }
  return found;
}

test('every shipped schema prepares for claude without $schema, $id or file refs', () => {
  const files = readdirSync(pluginSchemas).filter((f) => f.endsWith('.json'));
  assert.equal(files.length, 8);
  for (const file of files) {
    const raw = readJson(join(pluginSchemas, file));
    const prepared = schemaForRunner(raw, pluginSchemas);
    const text = JSON.stringify(prepared);
    assert.ok(!text.includes('"$schema"') && !text.includes('"$id"'), file);
    assert.deepEqual(refsIn(prepared).filter((ref) => !ref.startsWith('#')), [], `${file}: no file $ref`);
    assert.ok('$schema' in raw, `${file}: the input is not mutated`);
  }
  const category = schemaForRunner(readJson(join(pluginSchemas, 'finding-category.schema.json')), pluginSchemas);
  const candidate = schemaForRunner(readJson(join(pluginSchemas, 'candidate.schema.json')), pluginSchemas);
  const { description, ...inlined } = candidate.properties.candidates.items.properties.category;
  assert.deepEqual(inlined, category);
  assert.match(description, /Kind of consequence/);
});

test('schemaForRunner keeps local $defs refs, follows file fragments, and refuses the rest', (t) => {
  const dir = tempDir(t);
  const schemas = join(dir, 'schemas');
  mkdirSync(schemas);
  const put = (name, value) => writeFileSync(join(schemas, name), JSON.stringify(value));
  put('defs.json', { $defs: { id: { type: 'string', $id: 'x' } } });
  put('a.json', { $ref: 'b.json' });
  put('b.json', { $ref: 'a.json' });
  put('inner.json', { $defs: { y: {} }, properties: { z: { $ref: '#/$defs/y' } } });
  writeFileSync(join(dir, 'outside.json'), '{}');

  const kept = schemaForRunner(
    { $defs: { n: { type: 'number' } }, properties: { a: { $ref: '#/$defs/n' }, b: { $ref: 'defs.json#/$defs/id' } } },
    schemas,
  );
  assert.deepEqual(kept.properties, { a: { $ref: '#/$defs/n' }, b: { type: 'string' } });

  const refuse = (ref, pattern, document = { properties: { x: { $ref: ref } } }) =>
    assert.throws(() => schemaForRunner(document, schemas), pattern, ref);
  refuse('/etc/schema.json', /absolute/);
  refuse('https://example.com/s.json', /absolute/);
  refuse('../outside.json', /leaves/);
  refuse('a.json', /cycle/);
  refuse('defs.json#/$defs/missing', /does not resolve/);
  refuse('defs.json#anchor', /does not resolve/);
  refuse('missing.json', /cannot be read/);
  refuse('inner.json', /cannot be kept/);
  refuse('#/properties/x', /\$defs or definitions/);
  refuse('#/$defs/missing', /\$defs or definitions/);
});

test('the stub receives the prepared schema on argv', async (t) => {
  const dir = tempDir(t);
  const stub = writeStub(dir);
  const record = join(dir, 'record.json');
  const raw = readJson(join(pluginSchemas, 'candidate.schema.json'));
  const result = await runAgent({ ...analyst, schema: raw }, 'x', dir, [], stubEnv(stub, { STUB_RECORD: record }));
  assert.equal(result.ok, true, result.error);
  const { argv } = readJson(record);
  assert.deepEqual(JSON.parse(valueAfter(argv, '--json-schema')), schemaForRunner(raw, pluginSchemas));
  assert.doesNotMatch(valueAfter(argv, '--json-schema'), /\$schema|finding-category\.schema\.json/);
});

test('readAgentTools parses every agent file', () => {
  const names = readdirSync(pluginAgents)
    .filter((f) => f.endsWith('.md'))
    .map((f) => f.slice(0, -3));
  assert.ok(names.length >= 7);
  for (const name of names) {
    const tools = readAgentTools(name);
    assert.ok(Array.isArray(tools), name);
    for (const tool of tools) assert.match(tool, /^[A-Za-z]+(\(git:\*\))?$/, `${name}: ${tool}`);
  }
  assert.deepEqual(readAgentTools('diff-analyst'), ['Read', 'Grep', 'Glob', 'Bash(git:*)']);
  assert.deepEqual(readAgentTools('concise-editor'), []);
  assert.deepEqual(readAgentTools('intent-extractor'), ['Read']);
  assert.equal(agentsDir(), pluginAgents);
});

test('readAgentTools refuses an unknown or path-shaped name', () => {
  assert.throws(() => readAgentTools('no-such-agent'), /Unknown agent/);
  assert.throws(() => readAgentTools('../README'), /Unknown agent/);
});

test('agent tools parse from a YAML block list as well as a comma list', () => {
  assert.deepEqual(parseAgentTools('---\nname: a\ntools:\n  - Read\n  - "Grep"\n- Glob\ndescription: d\n---\nbody', 'a.md'), [
    'Read',
    'Grep',
    'Glob',
  ]);
  assert.deepEqual(parseAgentTools('---\ntools:\ndescription: d\n---\n', 'a.md'), []);
  assert.deepEqual(parseAgentTools('---\r\ntools: [Read, Grep]\r\n---\r\n', 'a.md'), ['Read', 'Grep']);
});

test('a __proto__ key in a schema stays data, not a prototype swap', () => {
  const raw = JSON.parse('{"properties":{"__proto__":{"type":"string"},"ok":{"type":"number"}}}');
  const prepared = schemaForRunner(raw, pluginSchemas);
  assert.ok(Object.hasOwn(prepared.properties, '__proto__'));
  assert.equal(Object.getPrototypeOf(prepared.properties), Object.prototype);
  assert.deepEqual(JSON.parse(JSON.stringify(prepared)), {
    properties: JSON.parse('{"__proto__":{"type":"string"},"ok":{"type":"number"}}'),
  });
});

test('the fake backend refuses a path-shaped agent name before touching the filesystem', async (t) => {
  const dir = tempDir(t);
  const fakes = join(dir, 'fakes');
  mkdirSync(fakes);
  const result = await runAgent({ ...analyst, name: '../x' }, 'p', dir, [], { REVIEW_VOICE_FAKE_AGENTS: fakes });
  assert.equal(result.ok, false);
  assert.match(result.error, /Unknown agent/);
  assert.deepEqual(readdirSync(fakes), []);
  assert.equal(existsSync(join(dir, 'x.count')), false);
});

// ---------------------------------------------------------------------------
// The fake backend and the `agent` command, through the built bundle.

function runCli(args, { input = '', env = {} } = {}) {
  const base = { ...process.env };
  delete base.REVIEW_VOICE_FAKE_AGENTS;
  delete base.REVIEW_VOICE_AGENT_RUNNER;
  try {
    const stdout = execFileSync(process.execPath, [bundle, ...args], {
      encoding: 'utf8',
      input,
      env: { ...base, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { code: 0, stdout, stderr: '' };
  } catch (error) {
    return { code: error.status, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

function fakeSetup(t) {
  const dir = tempDir(t);
  const fakes = join(dir, 'fakes');
  mkdirSync(fakes);
  const schema = join(dir, 'schema.json');
  writeFileSync(schema, JSON.stringify(SCHEMA));
  return { dir, fakes, schema, env: { REVIEW_VOICE_FAKE_AGENTS: fakes, REVIEW_VOICE_DATA_DIR: join(dir, 'data') } };
}

const agentArgs = (schema) => ['agent', '--name', 'diff-analyst', '--model', 'haiku', '--schema', schema];

test('fake backend counts calls across processes, captures prompts and falls back', (t) => {
  const { fakes, schema, env } = fakeSetup(t);
  writeFileSync(join(fakes, 'diff-analyst.1.json'), JSON.stringify({ output: { answer: 'first' } }));
  writeFileSync(join(fakes, 'diff-analyst.json'), JSON.stringify({ output: { answer: 'fallback' } }));

  const first = runCli(agentArgs(schema), { input: 'prompt one', env });
  assert.equal(first.code, 0, first.stderr);
  assert.deepEqual(JSON.parse(first.stdout).output, { answer: 'first' });

  const second = runCli(agentArgs(schema), { input: 'prompt two', env });
  assert.equal(second.code, 0, second.stderr);
  const parsed = JSON.parse(second.stdout);
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.output, { answer: 'fallback' });
  assert.equal(parsed.costUsd, null);

  const calls = join(fakes, '.calls');
  assert.equal(readFileSync(join(calls, 'diff-analyst.count'), 'utf8').trim(), '2');
  assert.equal(readFileSync(join(calls, 'diff-analyst.1.prompt.txt'), 'utf8'), `${RUNNER_PREAMBLE}\n\nprompt one`);
  assert.equal(readFileSync(join(calls, 'diff-analyst.2.prompt.txt'), 'utf8'), `${RUNNER_PREAMBLE}\n\nprompt two`);
  const spec = JSON.parse(readFileSync(join(calls, 'diff-analyst.2.spec.json'), 'utf8'));
  assert.equal(spec.model, 'haiku');
  assert.deepEqual(spec.tools, ['Read', 'Grep', 'Glob'], 'host-only git is stripped');
});

test('fake backend serves an error file as a failed call, and a missing file names its path', (t) => {
  const { fakes, schema, env } = fakeSetup(t);
  writeFileSync(join(fakes, 'diff-analyst.1.json'), JSON.stringify({ error: 'model refused' }));

  const failed = runCli(agentArgs(schema), { input: 'p', env });
  assert.equal(failed.code, 1);
  const parsed = JSON.parse(failed.stdout);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.error, 'model refused');

  const missing = runCli(agentArgs(schema), { input: 'p', env });
  assert.equal(missing.code, 1);
  assert.match(JSON.parse(missing.stdout).error, /diff-analyst\.json/);
});

test('REVIEW_VOICE_AGENT_RUNNER=fake without a directory is a failed call, not a real model', (t) => {
  const { schema, dir } = fakeSetup(t);
  const result = runCli(agentArgs(schema), {
    input: 'p',
    env: { REVIEW_VOICE_AGENT_RUNNER: 'fake', REVIEW_VOICE_CLAUDE_BIN: join(dir, 'no-such-claude') },
  });
  assert.equal(result.code, 1);
  assert.match(JSON.parse(result.stdout).error, /REVIEW_VOICE_FAKE_AGENTS/);
});

test('agent runs the claude-cli backend from the CLI and exits 0 or 1', (t) => {
  const { dir, schema } = fakeSetup(t);
  const stub = writeStub(dir);
  const ok = runCli([...agentArgs(schema), '--cwd', dir, '--timeout', '30'], {
    input: 'p',
    env: { REVIEW_VOICE_CLAUDE_BIN: stub, ANTHROPIC_API_KEY: '' },
  });
  assert.equal(ok.code, 0, ok.stderr);
  assert.equal(JSON.parse(ok.stdout).costUsd, 0.0123);

  // A sibling-file $ref resolves next to the --schema file, not the plugin's schemas/.
  const own = join(dir, 'own');
  mkdirSync(own);
  writeFileSync(join(own, 'part.json'), JSON.stringify({ $schema: 'x', type: 'string' }));
  writeFileSync(join(own, 'main.json'), JSON.stringify({ properties: { p: { $ref: 'part.json' } } }));
  const record = join(dir, 'cli-record.json');
  const sibling = runCli(['agent', '--name', 'diff-analyst', '--model', 'haiku', '--schema', join(own, 'main.json'), '--cwd', dir], {
    input: 'p',
    env: { REVIEW_VOICE_CLAUDE_BIN: stub, ANTHROPIC_API_KEY: '', STUB_RECORD: record },
  });
  assert.equal(sibling.code, 0, sibling.stderr);
  assert.deepEqual(JSON.parse(valueAfter(readJson(record).argv, '--json-schema')), { properties: { p: { type: 'string' } } });

  const failed = runCli([...agentArgs(schema), '--cwd', dir], {
    input: 'p',
    env: { REVIEW_VOICE_CLAUDE_BIN: stub, STUB_MODE: 'is-error' },
  });
  assert.equal(failed.code, 1);
  assert.equal(JSON.parse(failed.stdout).ok, false);
});

async function gone(pid) {
  for (let i = 0; i < 100; i += 1) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
}

for (const [signal, exitCode] of [['SIGTERM', 143], ['SIGINT', 130]]) {
  test(`${signal} to the CLI kills every live agent process group and exits ${exitCode}`, async (t) => {
    const { dir, schema } = fakeSetup(t);
    const stub = writeStub(dir);
    const pids = join(dir, 'pids.json');
    const env = { ...process.env, REVIEW_VOICE_CLAUDE_BIN: stub, STUB_MODE: 'sleep', STUB_CHILD_PID: pids };
    delete env.REVIEW_VOICE_FAKE_AGENTS;
    delete env.REVIEW_VOICE_AGENT_RUNNER;
    const cli = spawn(process.execPath, [bundle, ...agentArgs(schema), '--cwd', dir], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    t.after(() => {
      for (const pid of existsSync(pids) ? Object.values(readJson(pids)) : []) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {}
      }
      cli.kill('SIGKILL');
    });
    const closed = new Promise((resolve) => cli.on('close', (code) => resolve(code)));
    cli.stdin.end('p');
    for (let i = 0; i < 500 && !existsSync(pids); i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(existsSync(pids), 'the stub started');
    const { stub: stubPid, child } = readJson(pids);

    cli.kill(signal);

    assert.equal(await closed, exitCode);
    assert.ok(await gone(stubPid), 'the claude process is gone');
    assert.ok(await gone(child), 'its child is gone');
  });
}

test('agent exits 2 on a bad invocation', (t) => {
  const { dir, schema, env } = fakeSetup(t);
  const garbled = join(dir, 'garbled.json');
  writeFileSync(garbled, '{not json');
  const badRef = join(dir, 'bad-ref.json');
  writeFileSync(badRef, JSON.stringify({ properties: { x: { $ref: '../escape.json' } } }));

  const cases = [
    ['agent', '--model', 'haiku', '--schema', schema],
    ['agent', '--name', 'diff-analyst', '--schema', schema],
    ['agent', '--name', 'diff-analyst', '--model', 'haiku'],
    ['agent', '--name', 'no-such-agent', '--model', 'haiku', '--schema', schema],
    ['agent', '--name', 'diff-analyst', '--model', 'haiku', '--schema', join(dir, 'missing.json')],
    ['agent', '--name', 'diff-analyst', '--model', 'haiku', '--schema', garbled],
    ['agent', '--name', 'diff-analyst', '--model', 'haiku', '--schema', badRef],
    [...agentArgs(schema), '--timeout', '0'],
    [...agentArgs(schema), '--timeout', '3601'],
    [...agentArgs(schema), '--timeout', 'soon'],
    [...agentArgs(schema), '--cwd', join(dir, 'not-a-dir')],
  ];
  for (const args of cases) {
    const result = runCli(args, { input: 'p', env });
    assert.equal(result.code, 2, `${args.join(' ')}: ${result.stderr}`);
  }
  assert.equal(existsSync(join(dir, 'fakes', '.calls')), false, 'no call was made');
});

test('agent --help documents its flags and exit codes', () => {
  const { code, stdout } = runCli(['agent', '--help']);
  assert.equal(code, 0);
  for (const text of ['--name', '--model', '--schema', '--cwd', '--timeout', 'Exit codes']) {
    assert.ok(stdout.includes(text), text);
  }
});

test('doctor reports claude as informational, present or not', (t) => {
  const dir = tempDir(t);
  const stub = writeStub(dir);
  const present = runCli(['doctor'], { env: { REVIEW_VOICE_CLAUDE_BIN: stub } });
  assert.equal(present.code, 0);
  assert.match(present.stdout, /claude\s+found \(login not checked\): 9\.9\.9 \(Stub Code\)/);

  const absent = runCli(['doctor'], { env: { REVIEW_VOICE_CLAUDE_BIN: join(dir, 'no-such-claude') } });
  assert.equal(absent.code, 0, 'a missing claude does not fail doctor');
  assert.match(absent.stdout, /claude\s+\S*no-such-claude not found on PATH/);
});
