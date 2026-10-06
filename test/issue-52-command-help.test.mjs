import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// `review-voice <command> --help` printed the whole top-level text for every
// command, so a command's flags were hard to find.

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const plugin = join(root, 'plugins/review-voice');
const bundle = join(plugin, 'dist/review-voice.mjs');

function run(args, input = '') {
  const result = spawnSync(process.execPath, [bundle, ...args], { encoding: 'utf8', input });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

const top = run(['--help']);
assert.equal(top.code, 0);

/** The names in the top-level `Commands:` list, other than the two options. */
const COMMANDS = [...top.stdout.split('\n\n')[1].matchAll(/^ {2}([a-z][a-z-]*)\s/gm)].map((m) => m[1]);

test('the top-level list names every dispatched command', () => {
  const source = readFileSync(join(plugin, 'src/cli.ts'), 'utf8');
  const dispatched = [...source.matchAll(/^ {4}case '([a-z][a-z-]*)':/gm)].map((m) => m[1]);
  for (const name of dispatched) {
    if (name === 'help') continue;
    assert.ok(COMMANDS.includes(name), `${name} is dispatched but missing from the command list`);
  }
  assert.ok(COMMANDS.includes('thread') && COMMANDS.includes('anchors'));
});

for (const command of COMMANDS) {
  test(`${command} --help prints only that command's usage`, () => {
    const { code, stdout } = run([command, '--help']);
    assert.equal(code, 0);
    assert.ok(stdout.startsWith(`review-voice ${command}`), `starts with the synopsis, got: ${stdout.slice(0, 60)}`);
    assert.ok(stdout.length < top.stdout.length / 2, 'shorter than the top-level help');
    assert.ok(!stdout.includes('Commands:'), 'is not the command list');
    assert.match(stdout, /^Reads: /m);
    assert.match(stdout, /^Writes: /m);
  });
}

test('carry-candidates --help lists all its flags', () => {
  const { stdout } = run(['carry-candidates', '--help']);
  for (const name of [
    '--candidates', '--verification', '--since', '--head', '--diff-file', '--out',
    '--interdiff', '--interdiff-candidates', '--interdiff-verification', '--held',
  ]) {
    assert.ok(stdout.includes(name), `${name} missing`);
  }
});

test('reanchor --help lists all its flags', () => {
  const { stdout } = run(['reanchor', '--help']);
  for (const name of ['--candidate', '--line', '--scores', '--diff-file', '--path', '--candidates']) {
    assert.ok(stdout.includes(name), `${name} missing`);
  }
});

test('-h and help <command> print the same as --help', () => {
  const expected = run(['reanchor', '--help']);
  assert.deepEqual(run(['reanchor', '-h']), expected);
  assert.deepEqual(run(['help', 'reanchor']), expected);
  assert.equal(run(['help']).stdout, top.stdout);
});

test('the top-level help points at the per-command help and keeps the footer', () => {
  assert.match(top.stdout, /review-voice <command> --help/);
  assert.match(top.stdout, /Exit codes: /);
  assert.match(top.stdout, /Normally driven by/);
});

test('an unknown command with --help is an error, exit 2', () => {
  const { code, stderr } = run(['nonesuch', '--help']);
  assert.equal(code, 2);
  assert.match(stderr, /Unknown command: nonesuch/);
});

test('every flag review.md passes a command is in that command\'s own --help', () => {
  const markdown = readFileSync(join(plugin, 'commands/review.md'), 'utf8');
  const invocations = [...markdown.matchAll(/\bRV\s+([a-z-]+)((?:\s+--?[\w-]+(?:\s+[^\s`]+)?)*)/g)].map((m) => ({
    command: m[1],
    flags: [...(m[2] ?? '').matchAll(/--[\w-]+/g)].map((f) => f[0]),
  }));
  assert.ok(invocations.length > 10);
  for (const { command, flags } of invocations) {
    const { stdout } = run([command, '--help']);
    for (const name of flags) {
      assert.ok(stdout.includes(name), `RV ${command} ${name}: not in \`${command} --help\``);
    }
  }
});

test('a bad invocation points at the command help, exit 2', () => {
  const { code, stderr } = run(['reanchor']);
  assert.equal(code, 2);
  assert.match(stderr, /Run "review-voice reanchor --help" for its flags\./);
});

test('a command that rejects stdin on a terminal-less empty pipe still answers --help', () => {
  const { code, stdout } = run(['score', '--help'], '');
  assert.equal(code, 0);
  assert.match(stdout, /--exclude-pull/);
});
