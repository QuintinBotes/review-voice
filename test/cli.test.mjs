import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bundle = join(root, 'plugins/review-voice/dist/review-voice.mjs');

function run(args) {
  try {
    const stdout = execFileSync(process.execPath, [bundle, ...args], { encoding: 'utf8' });
    return { code: 0, stdout };
  } catch (error) {
    return { code: error.status, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

test('--version matches the plugin manifest', () => {
  const manifest = JSON.parse(
    readFileSync(join(root, 'plugins/review-voice/.claude-plugin/plugin.json'), 'utf8'),
  );
  const { code, stdout } = run(['--version']);
  assert.equal(code, 0);
  assert.equal(stdout.trim(), manifest.version);
});

test('the marketplace entry and the plugin manifest agree on version', () => {
  const manifest = JSON.parse(
    readFileSync(join(root, 'plugins/review-voice/.claude-plugin/plugin.json'), 'utf8'),
  );
  const marketplace = JSON.parse(
    readFileSync(join(root, '.claude-plugin/marketplace.json'), 'utf8'),
  );
  const entry = marketplace.plugins.find((p) => p.name === 'review-voice');
  assert.ok(entry, 'marketplace.json must list the review-voice plugin');
  assert.equal(entry.version, manifest.version);
});

test('doctor reports the required tooling and succeeds on a supported machine', () => {
  const { code, stdout } = run(['doctor']);
  assert.match(stdout, /node:sqlite/);
  assert.match(stdout, /\bgit\b/);
  assert.equal(code, 0, 'doctor should pass on a machine that can run the test suite');
});

test('no output leaks the node:sqlite experimental warning', () => {
  const { stdout, stderr = '' } = run(['doctor']);
  assert.doesNotMatch(stdout + stderr, /ExperimentalWarning/);
});

test('an unknown command fails loudly rather than silently', () => {
  const { code, stderr } = run(['definitely-not-a-command']);
  assert.equal(code, 2);
  assert.match(stderr, /Unknown command/);
});

test('--help does not require any runtime dependency to be installed', () => {
  const { code, stdout } = run(['--help']);
  assert.equal(code, 0);
  assert.match(stdout, /review-voice <command>/);
});
