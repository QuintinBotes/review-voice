/** Issue #132: every entry listed under Commands has usable command help. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bundle = join(root, 'plugins/review-voice/dist/review-voice.mjs');

function run(args) {
  const result = spawnSync(process.execPath, [bundle, ...args], { encoding: 'utf8' });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

test('every command listed by top-level help accepts --help', () => {
  const top = run(['--help']);
  assert.equal(top.code, 0, top.stderr);
  const commands = /^Commands:\n([\s\S]*?)\n\nOptions:/m.exec(top.stdout)?.[1] ?? '';
  const names = [...commands.matchAll(/^  ([a-z][a-z-]*)\s/gm)].map((match) => match[1]);
  assert.ok(names.length > 0, 'top-level help lists commands');
  assert.match(top.stdout, /^Options:\n  --version/m);

  for (const name of names) {
    const result = run([name, '--help']);
    assert.equal(result.code, 0, `${name}: ${result.stderr}`);
  }
});
