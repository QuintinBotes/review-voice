import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bundle = join(root, 'plugins/review-voice/dist/review-voice.mjs');

// `script` gives the child a pseudo-terminal on stdin, which is the case that
// used to block forever. BSD `script` (macOS) takes the command as arguments;
// util-linux `script` (CI) takes it as one -c string and needs -e to pass the
// child's exit status through.
const quote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;
const onTerminal = (argv) =>
  process.platform === 'linux'
    ? ['script', ['-qec', argv.map(quote).join(' '), '/dev/null']]
    : ['script', ['-q', '/dev/null', ...argv]];

const [probe, probeArgs] = onTerminal(['true']);
const hasScript = spawnSync(probe, probeArgs, { stdio: 'ignore' }).status === 0;

for (const command of ['check-candidates', 'score', 'record', 'validate-output', 'anchors', 'verify']) {
  test(`${command} on a terminal exits 2 at once naming what to pipe`, { skip: !hasScript }, () => {
    const [program, args] = onTerminal([process.execPath, bundle, command]);
    const result = spawnSync(program, args, {
      encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'],
    });
    assert.notEqual(result.error?.code, 'ETIMEDOUT', 'must not wait for input');
    assert.equal(result.status, 2);
    assert.match(result.stdout + result.stderr, new RegExp(`${command} reads .* on stdin; pipe it in`));
  });
}
